'use strict';

const { convertAstToCfg } = require('./ast-to-cfg');
const { eliminateDeadCodeCfg } = require('./deadCodeEliminator-cfg');
const { reconstructAstFromCfg } = require('./cfg-to-ast');
const { analyzePurity } = require('./purityAnalyzer');
const { collectExceptionMetadata } = require('./exceptionMetadata');
const { makeMethodKey, extractInvokeTarget } = require('./methodEffectsAnalyzer');
const { removeDummyStackOps } = require('./removeDummyStackOps');

function runDeadCodePass(astRoot, { collectDiagnostics = true, methodEffects = null } = {}) {
  const diagnostics = [];
  let changed = false;
  const purityInfo = astRoot ? analyzePurity(astRoot) : null;
  const methodLookup = new Map();

  for (const classItem of astRoot.classes || []) {
    const className = classItem.className || 'UnknownClass';
    for (const item of classItem.items || []) {
      if (!item || item.type !== 'method' || !item.method) {
        continue;
      }
      let methodNode = item.method;
      const key = makeMethodKey(className, methodNode.name, methodNode.descriptor);
      methodLookup.set(key, methodNode);
      const cfg = convertAstToCfg(methodNode);
      if (!cfg) {
        continue;
      }
      cfg.context = { className, methodName: methodNode.name, descriptor: methodNode.descriptor };
      const result = eliminateDeadCodeCfg(cfg, {
        isInvocationPure: (signature) => {
          if (!purityInfo) return false;
          const info = purityInfo[signature];
          return info && info.pure === true;
        },
      });
      if (!result.changed) {
        continue;
      }
      let optimizedMethod;
      try {
        optimizedMethod = reconstructAstFromCfg(result.optimizedCfg, methodNode);
      } catch (err) {
        err.message = `While optimizing ${className}.${methodNode.name}${methodNode.descriptor}: ${err.message}`;
        throw err;
      }
      item.method = optimizedMethod;
      methodNode = optimizedMethod;
      methodLookup.set(makeMethodKey(className, methodNode.name, methodNode.descriptor), methodNode);
      changed = true;
      if (collectDiagnostics) {
        diagnostics.push({
          className,
          methodName: optimizedMethod.name,
          descriptor: optimizedMethod.descriptor,
          message: 'Dead handler/jump detected; handler body can be simplified.',
        });
      }
    }
  }

  const metadata = collectExceptionMetadata(astRoot);
  metadata.forEach((entry) => {
    const methodNode = methodLookup.get(
      makeMethodKey(entry.className, entry.methodName, entry.descriptor),
    );
    if (!methodNode) {
      return;
    }
    const effectsEntry =
      methodEffects && methodEffects.get(makeMethodKey(entry.className, entry.methodName, entry.descriptor));
    const safeByEffects =
      effectsEntry &&
      !effectsEntry.throwsUnknown &&
      effectsEntry.throws &&
      effectsEntry.throws.size === 0;
    if (!safeByEffects) {
      if (!entry.declared.length || entry.implicit.length) {
        return;
      }
    }
    const flags = methodNode.flags || [];
    if (flags.includes('abstract') || flags.includes('native')) {
      return;
    }
    const hasCodeAttribute = (methodNode.attributes || []).some(
      (attr) => attr && attr.type === 'code',
    );
    if (!hasCodeAttribute) {
      return;
    }
    const attrs = methodNode.attributes || [];
    const filtered = attrs.filter((attr) => attr && attr.type !== 'exceptions');
    if (filtered.length === attrs.length) {
      return;
    }
    methodNode.attributes = filtered;
    changed = true;
    if (collectDiagnostics) {
      diagnostics.push({
        className: entry.className,
        methodName: entry.methodName,
        descriptor: entry.descriptor,
        message: 'Removed declared exceptions that cannot fire.',
      });
    }
  });

  if (methodEffects) {
    for (const classItem of astRoot.classes || []) {
      const className = classItem.className || 'UnknownClass';
      for (const item of classItem.items || []) {
        if (!item || item.type !== 'method' || !item.method) continue;
        const removal = removePureInvocations(item.method, methodEffects, {
          className,
          collectDiagnostics,
        });
        if (removal.changed) {
          changed = true;
          if (collectDiagnostics) {
            removal.removals.forEach((callee) => {
              diagnostics.push({
                className,
                methodName: item.method.name,
                descriptor: item.method.descriptor,
                message: `Removed pure call to ${callee.className}.${callee.methodName}${callee.descriptor}.`,
              });
            });
          }
        }
      }
    }
  }

  const dummyRemoval = removeDummyStackOps(astRoot);
  if (dummyRemoval.changed) {
    changed = true;
    if (collectDiagnostics) {
      dummyRemoval.methods.forEach((method) => {
        diagnostics.push({
          className: method.className,
          methodName: method.methodName,
          descriptor: method.descriptor,
          message: `Removed ${method.removedPairs} redundant push/pop pair(s).`,
        });
      });
    }
  }

  return collectDiagnostics ? { diagnostics, changed } : { changed };
}

module.exports = { runDeadCodePass };
function returnsVoid(descriptor) {
  return typeof descriptor === 'string' && descriptor.endsWith(')V');
}

function canRemoveInvocation(callee, methodEffects) {
  if (!callee || !returnsVoid(callee.descriptor)) {
    return false;
  }
  if (!methodEffects) {
    return false;
  }
  const effect = methodEffects.get(makeMethodKey(callee.className, callee.methodName, callee.descriptor));
  if (!effect || !effect.pure) {
    return false;
  }
  if (effect.throwsUnknown) {
    return false;
  }
  if (effect.throws && effect.throws.size) {
    return false;
  }
  return true;
}

function removePureInvocations(methodNode, methodEffects, { className, collectDiagnostics }) {
  const codeAttr = (methodNode.attributes || []).find((attr) => attr && attr.type === 'code');
  if (!codeAttr || !codeAttr.code || !Array.isArray(codeAttr.code.codeItems)) {
    return { changed: false, removals: [] };
  }
  const newItems = [];
  const removals = [];
  let changed = false;
  codeAttr.code.codeItems.forEach((item) => {
    if (!item || !item.instruction) {
      newItems.push(item);
      return;
    }
    const callee = extractInvokeTarget(item.instruction);
    if (canRemoveInvocation(callee, methodEffects)) {
      changed = true;
      removals.push({
        className: callee.className,
        methodName: callee.methodName,
        descriptor: callee.descriptor,
      });
      if (item.labelDef || item.stackMapFrame) {
        const clone = { ...item };
        delete clone.instruction;
        newItems.push(clone);
      }
    } else {
      newItems.push(item);
    }
  });
  if (changed) {
    codeAttr.code.codeItems = newItems;
  }
  return { changed, removals };
}

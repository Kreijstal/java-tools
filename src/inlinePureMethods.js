const { analyzePurity, _internals: purityInternals } = require('./purityAnalyzer');
const { normalizeInstruction, getStackEffect } = require('./utils/instructionUtils');

const { buildMethodSignature } = purityInternals;

const RETURN_PREFIX = new Map([
  ['ireturn', 'i'],
  ['lreturn', 'l'],
  ['freturn', 'f'],
  ['dreturn', 'd'],
  ['areturn', 'a'],
]);

const PREFIX_TO_LOAD = {
  i: 'iload',
  l: 'lload',
  f: 'fload',
  d: 'dload',
  a: 'aload',
};

const PREFIX_TO_STORE = {
  i: 'istore',
  l: 'lstore',
  f: 'fstore',
  d: 'dstore',
  a: 'astore',
};

const KIND_TO_PREFIX = {
  B: 'i',
  C: 'i',
  S: 'i',
  Z: 'i',
  I: 'i',
  F: 'f',
  J: 'l',
  D: 'd',
  A: 'a',
};

function createInstructionItem(op, index) {
  if (index === undefined || index === null) {
    return { instruction: op };
  }
  return { instruction: { op, arg: String(index) } };
}

function getInvocationTarget(instruction) {
  if (!instruction || !Array.isArray(instruction.arg)) {
    return null;
  }
  const [, owner, nameDesc] = instruction.arg;
  if (!owner || !Array.isArray(nameDesc)) {
    return null;
  }
  const [name, descriptor] = nameDesc;
  if (!name || !descriptor) {
    return null;
  }
  return `${owner}.${name}${descriptor}`;
}

function parseType(descriptor, index) {
  if (!descriptor || index >= descriptor.length) {
    return null;
  }

  let cursor = index;
  let arrayDepth = 0;
  while (descriptor[cursor] === '[') {
    arrayDepth += 1;
    cursor += 1;
  }

  if (cursor >= descriptor.length) {
    return null;
  }

  let kind = descriptor[cursor];
  cursor += 1;

  if (kind === 'L') {
    while (cursor < descriptor.length && descriptor[cursor] !== ';') {
      cursor += 1;
    }
    if (cursor >= descriptor.length) {
      return null;
    }
    cursor += 1;
    kind = 'A';
  }

  if (arrayDepth > 0) {
    kind = 'A';
  }

  if (kind === 'V') {
    return { nextIndex: cursor, width: 0, kind };
  }

  const width = kind === 'J' || kind === 'D' ? 2 : 1;
  return { nextIndex: cursor, width, kind };
}

function parseMethodDescriptorLayout(descriptor, isStatic) {
  if (!descriptor || descriptor[0] !== '(') {
    return null;
  }

  const args = [];
  let cursor = 1;
  let localIndex = isStatic ? 0 : 1;
  let argIndex = 0;

  while (cursor < descriptor.length && descriptor[cursor] !== ')') {
    const type = parseType(descriptor, cursor);
    if (!type) {
      return null;
    }
    const prefix = KIND_TO_PREFIX[type.kind];
    if (!prefix) {
      return null;
    }
    args.push({
      argIndex,
      localIndex,
      width: type.width,
      kind: type.kind,
      prefix,
    });
    localIndex += type.width;
    argIndex += 1;
    cursor = type.nextIndex;
  }

  if (cursor >= descriptor.length || descriptor[cursor] !== ')') {
    return null;
  }

  const returnType = parseType(descriptor, cursor + 1);
  if (!returnType) {
    return null;
  }

  let returnPrefix = null;
  if (returnType.kind !== 'V') {
    returnPrefix = KIND_TO_PREFIX[returnType.kind];
    if (!returnPrefix) {
      return null;
    }
  }

  return {
    args,
    returnKind: returnType.kind,
    returnPrefix,
    returnWidth: returnType.width,
  };
}

function buildStackEntries(code) {
  if (!code || !Array.isArray(code.codeItems)) {
    return null;
  }

  const entries = [];
  let unsupported = false;

  code.codeItems.forEach((codeItem) => {
    const normalized = normalizeInstruction(codeItem.instruction);
    if (!normalized || !normalized.op) {
      return;
    }
    const meta = getStackEffect(normalized.op, normalized);
    if (!meta) {
      unsupported = true;
      return;
    }
    entries.push({
      normalized,
      originalInstruction: codeItem.instruction,
      meta,
      consumes: [],
      produced: [],
    });
  });

  if (unsupported) {
    return null;
  }

  const stack = [];
  for (const entry of entries) {
    let remaining = entry.meta.popSlots;
    const consumed = [];

    while (remaining > 0) {
      const value = stack.pop();
      if (!value) {
        return null;
      }
      consumed.push(value);
      remaining -= value.width;
    }

    if (remaining !== 0) {
      return null;
    }

    entry.consumes = consumed;

    if (entry.meta.pushSlots > 0) {
      const produced = { producer: entry, width: entry.meta.pushSlots };
      entry.produced.push(produced);
      stack.push(produced);
    }
  }

  return entries;
}

function getLoadDetails(entry) {
  if (!entry || !entry.normalized) {
    return null;
  }
  const {op} = entry.normalized;
  if (!op) {
    return null;
  }

  let base = op;
  let index = null;

  if (op.includes('_')) {
    const [prefix, suffix] = op.split('_');
    base = prefix;
    index = Number.parseInt(suffix, 10);
    if (!Number.isInteger(index)) {
      return null;
    }
  } else if (
    entry.originalInstruction &&
    typeof entry.originalInstruction === 'object' &&
    entry.originalInstruction.arg !== undefined
  ) {
    base = op;
    index = Number.parseInt(entry.originalInstruction.arg, 10);
    if (!Number.isInteger(index)) {
      return null;
    }
  } else {
    return null;
  }

  if (!['iload', 'lload', 'fload', 'dload', 'aload'].includes(base)) {
    return null;
  }

  const prefix = base[0];
  const width = prefix === 'l' || prefix === 'd' ? 2 : 1;

  return { base, index, prefix, width };
}

function gatherMethods(ast) {
  const methods = new Map();
  if (!ast || !Array.isArray(ast.classes)) {
    return methods;
  }

  for (const cls of ast.classes) {
    if (!cls || !Array.isArray(cls.items)) {
      continue;
    }
    const {className} = cls;
    if (!className) {
      continue;
    }
    for (const item of cls.items) {
      if (!item || item.type !== 'method' || !item.method) {
        continue;
      }
      const {method} = item;
      const signature = buildMethodSignature(className, method.name, method.descriptor);
      const codeAttr = (method.attributes || []).find((attr) => attr.type === 'code');
      methods.set(signature, {
        signature,
        className,
        method,
        item,
        codeAttr,
      });
    }
  }

  return methods;
}

function analyzeMethodReturn(methodInfo) {
  if (!methodInfo || !methodInfo.method) {
    return null;
  }

  const {method} = methodInfo;
  const isStatic = Array.isArray(method.flags) && method.flags.includes('static');
  if (!isStatic) {
    return null;
  }

  const {codeAttr} = methodInfo;
  if (!codeAttr || !codeAttr.code) {
    return null;
  }

  const layout = parseMethodDescriptorLayout(method.descriptor, true);
  if (!layout || !layout.returnPrefix) {
    return null;
  }

  const entries = buildStackEntries(codeAttr.code);
  if (!entries) {
    return null;
  }

  const returns = entries.filter((entry) => RETURN_PREFIX.has(entry.normalized.op));
  if (returns.length !== 1) {
    return null;
  }

  const returnEntry = returns[0];
  if (!returnEntry.consumes || returnEntry.consumes.length !== 1) {
    return null;
  }

  const consumed = returnEntry.consumes[0];
  if (!consumed || !consumed.producer) {
    return null;
  }

  const loadDetails = getLoadDetails(consumed.producer);
  if (!loadDetails) {
    return null;
  }

  if (loadDetails.prefix !== layout.returnPrefix) {
    return null;
  }

  const targetArg = layout.args.find((arg) => arg.localIndex === loadDetails.index);
  if (!targetArg) {
    return null;
  }

  if (targetArg.prefix !== loadDetails.prefix) {
    return null;
  }

  return {
    signature: methodInfo.signature,
    argIndex: targetArg.argIndex,
    argLayouts: layout.args,
    prefix: targetArg.prefix,
    width: targetArg.width,
  };
}

function inlineInvocation(callerInfo, code, items, index, candidate) {
  if (!code || !Array.isArray(items)) {
    return null;
  }

  const { argLayouts, argIndex, prefix, width } = candidate;
  const replacements = [];

  for (let i = argLayouts.length - 1; i > argIndex; i -= 1) {
    const popOp = argLayouts[i].width === 2 ? 'pop2' : 'pop';
    replacements.push(createInstructionItem(popOp));
  }

  const storeOp = PREFIX_TO_STORE[prefix];
  const loadOp = PREFIX_TO_LOAD[prefix];
  if (!storeOp || !loadOp) {
    return null;
  }

  const localsSizeValue = Number(code.localsSize);
  if (!Number.isInteger(localsSizeValue) || localsSizeValue < 0) {
    return null;
  }
  const tempIndex = localsSizeValue;
  code.localsSize = String(localsSizeValue + width);

  replacements.push(createInstructionItem(storeOp, tempIndex));

  for (let i = argIndex - 1; i >= 0; i -= 1) {
    const popOp = argLayouts[i].width === 2 ? 'pop2' : 'pop';
    replacements.push(createInstructionItem(popOp));
  }

  replacements.push(createInstructionItem(loadOp, tempIndex));

  const originalItem = items[index];

  if (replacements.length === 0) {
    items.splice(index, 1);
    return { tempIndex, adjustment: -1 };
  }

  if (originalItem && originalItem.labelDef !== undefined) {
    replacements[0].labelDef = originalItem.labelDef;
  }
  if (originalItem && originalItem.pc !== undefined) {
    replacements[0].pc = originalItem.pc;
  }

  items.splice(index, 1, ...replacements);
  return { tempIndex, adjustment: replacements.length - 1 };
}

function inlinePureMethods(ast) {
  const summary = {};
  if (!ast || !Array.isArray(ast.classes)) {
    return { changed: false, summary };
  }

  const methods = gatherMethods(ast);
  if (methods.size === 0) {
    return { changed: false, summary };
  }

  const purity = analyzePurity(ast);
  const inlineable = new Map();

  for (const [signature, info] of methods) {
    const purityInfo = purity && purity[signature];
    if (!purityInfo || purityInfo.pure !== true) {
      continue;
    }
    const candidate = analyzeMethodReturn(info);
    if (candidate) {
      inlineable.set(signature, candidate);
    }
  }

  if (inlineable.size === 0) {
    return { changed: false, summary };
  }

  let changed = false;

  for (const [signature, info] of methods) {
    const codeAttr = info.codeAttr;
    if (!codeAttr || !codeAttr.code || !Array.isArray(codeAttr.code.codeItems)) {
      continue;
    }
    const items = codeAttr.code.codeItems;

    for (let i = 0; i < items.length; i += 1) {
      const normalized = normalizeInstruction(items[i].instruction);
      if (!normalized || normalized.op !== 'invokestatic') {
        continue;
      }
      const target = getInvocationTarget(normalized);
      if (!target) {
        continue;
      }
      const candidate = inlineable.get(target);
      if (!candidate) {
        continue;
      }

      const result = inlineInvocation(info, codeAttr.code, items, i, candidate);
      if (!result) {
        continue;
      }

      changed = true;
      if (!summary[signature]) {
        summary[signature] = [];
      }
      summary[signature].push({
        callee: target,
        argIndex: candidate.argIndex,
        tempLocalIndex: result.tempIndex,
      });

      i += result.adjustment;
    }
  }

  return { changed, summary };
}

module.exports = { inlinePureMethods };

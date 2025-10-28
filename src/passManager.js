const { convertAstToCfg } = require('./ast-to-cfg');
const { reconstructAstFromCfg } = require('./cfg-to-ast');
const { constantFoldCfg } = require('./constantFolder-cfg');
const { eliminateDeadCodeCfg } = require('./deadCodeEliminator-cfg');
const { inlinePureMethods } = require('./inlinePureMethods');
const { createStaticInvokeEvaluator } = require('./utils/staticInvokeEvaluator');

function formatMethodSignature(className, method) {
  return `${className}.${method.name}${method.descriptor}`;
}

function runCfgPasses(program, options = {}) {
  const foldChanged = [];
  const foldLimitHits = [];
  const dceChanged = [];

  if (!program || !Array.isArray(program.classes)) {
    return {
      fold: { changed: false, methods: foldChanged, limitHits: foldLimitHits },
      dce: { changed: false, methods: dceChanged },
    };
  }

  const foldOptions = {};
  if (options && typeof options.evaluateStaticInvoke === 'function') {
    foldOptions.evaluateStaticInvoke = options.evaluateStaticInvoke;
  }
  if (options && options.limits) {
    foldOptions.limits = options.limits;
  }
  const skipConstantFold = Boolean(options && options.skipConstantFold);
  const skipDeadCode = Boolean(options && options.skipDeadCode);

  for (const cls of program.classes) {
    if (!cls || !Array.isArray(cls.items)) {
      continue;
    }
    const className = cls.className || '<anonymous>';

    for (const item of cls.items) {
      if (!item || item.type !== 'method' || !item.method) {
        continue;
      }
      const method = item.method;
      const codeAttr = (method.attributes || []).find(({ type }) => type === 'code');
      if (!codeAttr) {
        continue;
      }

      const cfg = convertAstToCfg(method);
      let foldResult = { changed: false, optimizedCfg: cfg };
      if (!skipConstantFold) {
        foldResult = constantFoldCfg(cfg, foldOptions);
        if (foldResult.changed) {
          foldChanged.push(formatMethodSignature(className, method));
        }
        if (foldResult.limited) {
          foldLimitHits.push({
            method: formatMethodSignature(className, method),
            reason: foldResult.limited,
          });
        }
      }

      const foldedCfg = foldResult.optimizedCfg || cfg;
      let dceResult = { changed: false, optimizedCfg: foldedCfg };
      if (!skipDeadCode) {
        dceResult = eliminateDeadCodeCfg(foldedCfg);
        if (dceResult.changed) {
          dceChanged.push(formatMethodSignature(className, method));
        }
      }
      if (foldResult.changed || dceResult.changed) {
        const finalCfg = dceResult.optimizedCfg || foldedCfg;
        item.method = reconstructAstFromCfg(finalCfg, method);
      }
    }
  }

  return {
    fold: { changed: foldChanged.length > 0, methods: foldChanged, limitHits: foldLimitHits },
    dce: { changed: dceChanged.length > 0, methods: dceChanged },
  };
}

function runOptimizationPasses(program, options = {}) {
  const passes = [];

  const requestedPasses = Array.isArray(options.passes) && options.passes.length > 0
    ? new Set(options.passes)
    : null;
  const includePass = (name) => !requestedPasses || requestedPasses.has(name);

  const inlineEnabled = includePass('inlinePureMethods');
  const foldEnabled = includePass('constantFoldCfg');
  const dceEnabled = includePass('eliminateDeadCodeCfg');

  if (inlineEnabled) {
    const firstInline = inlinePureMethods(program);
    passes.push({
      name: 'inlinePureMethods',
      iteration: 1,
      changed: firstInline.changed || false,
      summary: firstInline.summary || null,
    });
  }

  if (foldEnabled || dceEnabled) {
    const firstEvaluator = foldEnabled ? createStaticInvokeEvaluator(program, options) : null;
    const firstCfg = runCfgPasses(program, {
      evaluateStaticInvoke: foldEnabled ? firstEvaluator : null,
      limits: options.limits,
      skipConstantFold: !foldEnabled,
      skipDeadCode: !dceEnabled,
    });
    if (foldEnabled) {
      passes.push({
        name: 'constantFoldCfg',
        iteration: 2,
        changed: firstCfg.fold.changed,
        methods: firstCfg.fold.methods,
        limitHits: firstCfg.fold.limitHits,
      });
    }
    if (dceEnabled) {
      passes.push({
        name: 'eliminateDeadCodeCfg',
        iteration: 3,
        changed: firstCfg.dce.changed,
        methods: firstCfg.dce.methods,
      });
    }
  }

  if (inlineEnabled) {
    const secondInline = inlinePureMethods(program);
    passes.push({
      name: 'inlinePureMethods',
      iteration: 4,
      changed: secondInline.changed || false,
      summary: secondInline.summary || null,
    });
  }

  if (foldEnabled || dceEnabled) {
    const secondEvaluator = foldEnabled ? createStaticInvokeEvaluator(program, options) : null;
    const secondCfg = runCfgPasses(program, {
      evaluateStaticInvoke: foldEnabled ? secondEvaluator : null,
      limits: options.limits,
      skipConstantFold: !foldEnabled,
      skipDeadCode: !dceEnabled,
    });
    if (foldEnabled) {
      passes.push({
        name: 'constantFoldCfg',
        iteration: 5,
        changed: secondCfg.fold.changed,
        methods: secondCfg.fold.methods,
        limitHits: secondCfg.fold.limitHits,
      });
    }
    if (dceEnabled) {
      passes.push({
        name: 'eliminateDeadCodeCfg',
        iteration: 6,
        changed: secondCfg.dce.changed,
        methods: secondCfg.dce.methods,
      });
    }
  }

  const changed = passes.some((pass) => pass.changed);
  return { changed, passes };
}

module.exports = {
  runOptimizationPasses,
};

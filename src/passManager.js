const { convertAstToCfg } = require('./ast-to-cfg');
const { reconstructAstFromCfg } = require('./cfg-to-ast');
const { constantFoldCfg } = require('./constantFolder-cfg');
const { eliminateDeadCodeCfg } = require('./deadCodeEliminator-cfg');
const { inlinePureMethods } = require('./inlinePureMethods');

function formatMethodSignature(className, method) {
  return `${className}.${method.name}${method.descriptor}`;
}

function runCfgPasses(program) {
  const foldChanged = [];
  const dceChanged = [];

  if (!program || !Array.isArray(program.classes)) {
    return {
      fold: { changed: false, methods: foldChanged },
      dce: { changed: false, methods: dceChanged },
    };
  }

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
      const foldResult = constantFoldCfg(cfg);
      if (foldResult.changed) {
        foldChanged.push(formatMethodSignature(className, method));
      }
      const dceResult = eliminateDeadCodeCfg(cfg);
      if (dceResult.changed) {
        dceChanged.push(formatMethodSignature(className, method));
      }
      if (foldResult.changed || dceResult.changed) {
        const finalCfg = dceResult.optimizedCfg || cfg;
        item.method = reconstructAstFromCfg(finalCfg, method);
      }
    }
  }

  return {
    fold: { changed: foldChanged.length > 0, methods: foldChanged },
    dce: { changed: dceChanged.length > 0, methods: dceChanged },
  };
}

function runOptimizationPasses(program) {
  const passes = [];

  const firstInline = inlinePureMethods(program);
  passes.push({
    name: 'inlinePureMethods',
    iteration: 1,
    changed: firstInline.changed || false,
    summary: firstInline.summary || null,
  });

  const firstCfg = runCfgPasses(program);
  passes.push({
    name: 'constantFoldCfg',
    iteration: 2,
    changed: firstCfg.fold.changed,
    methods: firstCfg.fold.methods,
  });
  passes.push({
    name: 'eliminateDeadCodeCfg',
    iteration: 3,
    changed: firstCfg.dce.changed,
    methods: firstCfg.dce.methods,
  });

  const secondInline = inlinePureMethods(program);
  passes.push({
    name: 'inlinePureMethods',
    iteration: 4,
    changed: secondInline.changed || false,
    summary: secondInline.summary || null,
  });

  const secondCfg = runCfgPasses(program);
  passes.push({
    name: 'constantFoldCfg',
    iteration: 5,
    changed: secondCfg.fold.changed,
    methods: secondCfg.fold.methods,
  });
  passes.push({
    name: 'eliminateDeadCodeCfg',
    iteration: 6,
    changed: secondCfg.dce.changed,
    methods: secondCfg.dce.methods,
  });

  const changed = passes.some((pass) => pass.changed);
  return { changed, passes };
}

module.exports = {
  runOptimizationPasses,
};

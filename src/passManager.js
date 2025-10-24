const { inlinePureMethods } = require('./inlinePureMethods');
const { constantFoldCfg } = require('./constantFolder-cfg');
const { eliminateDeadCodeCfg } = require('./deadCodeEliminator-cfg');
const { convertAstToCfg } = require('./ast-to-cfg');
const { reconstructAstFromCfg } = require('./cfg-to-ast');

const DEFAULT_PASS_SEQUENCE = ['inline', 'constantFold', 'deadCode', 'inline', 'constantFold', 'deadCode'];

function forEachMethod(program, visitor) {
  if (!program || !Array.isArray(program.classes)) {
    return;
  }
  for (const cls of program.classes) {
    if (!cls || !Array.isArray(cls.items)) {
      continue;
    }
    for (const item of cls.items) {
      if (!item || item.type !== 'method' || !item.method) {
        continue;
      }
      visitor(item.method, cls, item);
    }
  }
}

function runConstantFoldPass(program) {
  let changed = false;
  forEachMethod(program, (method, _cls, methodItem) => {
    const cfg = convertAstToCfg(method);
    const { changed: folded, optimizedCfg } = constantFoldCfg(cfg);
    if (folded) {
      methodItem.method = reconstructAstFromCfg(optimizedCfg, method);
      changed = true;
    }
  });
  return changed;
}

function runDeadCodePass(program) {
  let changed = false;
  forEachMethod(program, (method, _cls, methodItem) => {
    const cfg = convertAstToCfg(method);
    const { changed: eliminated, optimizedCfg } = eliminateDeadCodeCfg(cfg);
    if (eliminated) {
      methodItem.method = reconstructAstFromCfg(optimizedCfg, method);
      changed = true;
    }
  });
  return changed;
}

function runOptimizationPipeline(program, sequence = DEFAULT_PASS_SEQUENCE) {
  if (!Array.isArray(sequence) || sequence.length === 0) {
    throw new Error('Pass sequence must be a non-empty array.');
  }

  const stages = [];
  let overallChanged = false;

  for (const stage of sequence) {
    let stageChanged = false;
    switch (stage) {
      case 'inline': {
        const { changed } = inlinePureMethods(program);
        stageChanged = changed;
        break;
      }
      case 'constantFold':
        stageChanged = runConstantFoldPass(program);
        break;
      case 'deadCode':
        stageChanged = runDeadCodePass(program);
        break;
      default:
        throw new Error(`Unknown optimization pass: ${stage}`);
    }
    stages.push({ name: stage, changed: stageChanged });
    overallChanged = overallChanged || stageChanged;
  }

  return { changed: overallChanged, stages };
}

module.exports = {
  DEFAULT_PASS_SEQUENCE,
  runOptimizationPipeline,
};

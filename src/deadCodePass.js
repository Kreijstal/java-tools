'use strict';

const { convertAstToCfg } = require('./ast-to-cfg');
const { eliminateDeadCodeCfg } = require('./deadCodeEliminator-cfg');
const { reconstructAstFromCfg } = require('./cfg-to-ast');

function runDeadCodePass(astRoot, { collectDiagnostics = true } = {}) {
  const diagnostics = [];
  let changed = false;

  for (const classItem of astRoot.classes || []) {
    const className = classItem.className || 'UnknownClass';
    for (const item of classItem.items || []) {
      if (!item || item.type !== 'method' || !item.method) {
        continue;
      }
      const cfg = convertAstToCfg(item.method);
      if (!cfg) {
        continue;
      }
      const result = eliminateDeadCodeCfg(cfg);
      if (!result.changed) {
        continue;
      }
      const optimizedMethod = reconstructAstFromCfg(result.optimizedCfg, item.method);
      item.method = optimizedMethod;
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

  return collectDiagnostics ? { diagnostics, changed } : { changed };
}

module.exports = { runDeadCodePass };

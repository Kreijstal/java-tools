'use strict';

// Canonical normalized bytecode forms. A missing default remains undefined
// so callers can fail closed instead of silently dropping a CFG edge.
module.exports = function switchTargetLabels(instruction) {
  if (instruction?.op === 'tableswitch') {
    return [instruction.defaultLbl, ...(instruction.labels || [])];
  }
  return [instruction?.arg?.defaultLabel,
    ...(instruction?.arg?.pairs || []).map(pair => pair[1])];
};

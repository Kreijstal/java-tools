'use strict';
const switchTargetLabels = require('./switchTargetLabels');

// Normal successors only. Exception-table edges deliberately do not make a
// handler hot; any handler also reachable by ordinary control flow stays in
// the generated body. Refuse legacy subroutines and malformed branch targets.
module.exports = function normalInstructionReachability(items) {
  const labels = new Map();
  items.forEach((item, index) => {
    if (item.labelDef) labels.set(item.labelDef.replace(/:$/, ''), index);
  });
  const reachable = new Set(), pending = [0];
  const target = label => {
    const index = labels.get(Array.isArray(label) ? label[0] : label);
    if (index === undefined) throw new Error('unresolved branch');
    pending.push(index);
  };
  try {
    while (pending.length) {
      const index = pending.pop();
      if (index === items.length || reachable.has(index)) continue;
      if (index < 0 || index > items.length) return null;
      reachable.add(index);
      const instruction = items[index].instruction;
      const op = typeof instruction === 'string' ? instruction : instruction?.op;
      if (op === 'jsr' || op === 'jsr_w' || op === 'ret') return null;
      if (op === 'goto' || op === 'goto_w') { target(instruction.arg); continue; }
      if (op === 'tableswitch' || op === 'lookupswitch') {
        for (const label of switchTargetLabels(instruction)) target(label);
        continue;
      }
      if (op === 'athrow' || /^(?:[ialfd]return|return)$/.test(op || '')) continue;
      if (op?.startsWith('if')) target(instruction.arg);
      pending.push(index + 1);
    }
    return reachable;
  } catch (_) { return null; }
};

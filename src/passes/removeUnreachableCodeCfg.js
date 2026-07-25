'use strict';

const { buildCfg } = require('./splitArrayReachingLocal');

// CFG-reachability dead-code sweep.
//
// Several transforms can strand instruction islands that only reference each
// other (a dead goto targeting a dead block), which label-use-count cleanups
// like removeUnreferencedAfterTerminals can never delete. The JVM verifier
// ignores unreachable code, but CFR simulates every instruction it can walk
// to and dies on the residue ("Underrun type stack", "AALOAD ... Stack
// underflow"), taking the whole method's decompile with it.
//
// Instructions in blocks unreachable from the method entry (following
// branch, switch, fallthrough, and exception-handler edges) are replaced
// with nop. Replacing rather than deleting keeps every label definition and
// exception-table range valid without any offset bookkeeping. If the method
// tail goes dead, a stack-consistent `aconst_null; athrow` sentinel is
// appended so execution can never fall off the end of the code array.
function runRemoveUnreachableCodeCfg(astRoot) {
  let rewrites = 0;
  for (const cls of astRoot.classes || []) {
    for (const item of cls.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      for (const attr of item.method.attributes || []) {
        const code = attr && attr.type === 'code' && attr.code;
        if (!code || !Array.isArray(code.codeItems)) continue;
        rewrites += sweepCode(code);
      }
    }
  }
  return { changed: rewrites > 0, rewrites };
}

function sweepCode(code) {
  const items = code.codeItems;
  if (!items.length) return 0;
  const cfg = buildCfg(code);
  if (!cfg.blocks.length) return 0;
  const entryId = cfg.indexToBlock.get(firstInstructionIndex(items));
  if (!entryId) return 0;

  const reachable = new Set();
  const work = [entryId];
  while (work.length) {
    const id = work.pop();
    if (reachable.has(id)) continue;
    reachable.add(id);
    const block = cfg.byId.get(id);
    if (!block) continue;
    for (const succ of block.successors) {
      if (!reachable.has(succ)) work.push(succ);
    }
  }

  let touched = 0;
  let lastInstructionIndex = -1;
  let lastInstructionReachable = false;
  for (let i = 0; i < items.length; i += 1) {
    if (!items[i] || !items[i].instruction) continue;
    lastInstructionIndex = i;
    const blockId = cfg.indexToBlock.get(i);
    lastInstructionReachable = blockId != null && reachable.has(blockId);
    if (lastInstructionReachable) continue;
    if (op(items[i]) !== 'nop') {
      items[i].instruction = 'nop';
      touched += 1;
    }
  }
  if (touched === 0) return 0;

  if (lastInstructionIndex >= 0 && !lastInstructionReachable) {
    items.push({ instruction: 'aconst_null' }, { instruction: 'athrow' });
    if (Number(code.stackSize || 0) < 1) code.stackSize = '1';
  }
  return touched;
}

function firstInstructionIndex(items) {
  for (let i = 0; i < items.length; i += 1) {
    if (items[i] && items[i].instruction) return i;
  }
  return 0;
}

function op(item) {
  const insn = item && item.instruction;
  return typeof insn === 'string' ? insn : insn && insn.op;
}

module.exports = {
  runRemoveUnreachableCodeCfg,
};

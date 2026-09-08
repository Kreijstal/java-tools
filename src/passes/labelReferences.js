'use strict';

// Which labels a method's code refers to, and how.
//
// Each rule below was written out separately in several passes. They are moved
// here together with the helpers they call, because a function body is only
// identical up to its free identifiers -- moving a body without its closure is
// what broke this the first time it was attempted.
//
// `trimLabel` had two versions: one returned null for a non-string argument, the
// other returned the argument unchanged. For an actual label string they are
// identical, and every caller either guards with a typeof test first or discards
// falsy results, so the difference was an accident of two people writing the same
// helper, not a rule anyone relies on. It is one function now, normalising every
// non-label to null so "no label" has a single spelling.
//
// `collectReferencedLabels` is the opposite case and keeps two names: the two
// versions take different arguments and answer different questions. The
// FromCode form walks branch targets *and the exception table*; the FromItems
// form walks the instruction list only, seeded with labels the caller wants
// protected. Merging them would change what each caller computes.

const CONDITIONAL_JUMPS = new Set([
  'ifeq', 'ifne', 'iflt', 'ifge', 'ifgt', 'ifle',
  'if_icmpeq', 'if_icmpne', 'if_icmplt', 'if_icmpge', 'if_icmpgt', 'if_icmple',
  'if_acmpeq', 'if_acmpne',
  'ifnull', 'ifnonnull',
]);

function getOp(instruction) {
  if (!instruction) return null;
  if (typeof instruction === 'string') return instruction;
  return instruction.op || null;
}

function trimLabel(label) {
  return typeof label === 'string' ? label.replace(/:$/, '') : null;
}

function branchTargets(item) {
  const insn = item && item.instruction;
  if (!insn || typeof insn !== 'object') return [];
  if (insn.op === 'tableswitch' || insn.op === 'lookupswitch') {
    const out = [];
    const value = insn.arg;
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (Array.isArray(entry)) out.push(entry[entry.length - 1]);
        else if (typeof entry === 'string') out.push(entry);
      }
    }
    if (Array.isArray(insn.labels)) out.push(...insn.labels);
    if (insn.defaultLbl) out.push(insn.defaultLbl);
    return out;
  }
  return typeof insn.arg === 'string' ? [insn.arg] : [];
}

function referencedLabels(code) {
  const out = new Set();
  for (const item of code.codeItems || []) {
    for (const label of branchTargets(item)) out.add(trimLabel(label));
  }
  for (const entry of code.exceptionTable || []) {
    for (const label of [entry.startLbl, entry.endLbl, entry.handlerLbl]) out.add(trimLabel(label));
  }
  out.delete(null);
  return out;
}

function collectReferencedLabelsFromCode(code) {
  const out = new Set();
  for (const item of code.codeItems || []) {
    for (const target of branchTargets(item)) {
      const label = trimLabel(target);
      if (label) out.add(label);
    }
  }
  for (const entry of code.exceptionTable || []) {
    for (const value of [entry.startLbl, entry.endLbl, entry.handlerLbl]) {
      const label = trimLabel(value);
      if (label) out.add(label);
    }
  }
  return out;
}

function collectReferencedLabelsFromItems(codeItems, protectedLabels) {
  const set = new Set(protectedLabels);
  for (const item of codeItems) {
    if (!item || !item.instruction) continue;
    const insn = item.instruction;
    const op = getOp(insn);
    if (op === 'goto' || op === 'jsr' || CONDITIONAL_JUMPS.has(op)) {
      if (typeof insn.arg === 'string') set.add(trimLabel(insn.arg));
    } else if (op === 'tableswitch') {
      for (const l of (insn.labels || [])) set.add(trimLabel(l));
      if (typeof insn.defaultLbl === 'string') set.add(trimLabel(insn.defaultLbl));
    } else if (op === 'lookupswitch' && insn.arg && typeof insn.arg === 'object') {
      for (const pair of (insn.arg.pairs || [])) {
        if (Array.isArray(pair) && typeof pair[1] === 'string') set.add(trimLabel(pair[1]));
      }
      if (typeof insn.arg.defaultLabel === 'string') set.add(trimLabel(insn.arg.defaultLabel));
    }
  }
  return set;
}

module.exports = {
  CONDITIONAL_JUMPS, getOp, trimLabel, branchTargets, referencedLabels,
  collectReferencedLabelsFromCode, collectReferencedLabelsFromItems,
};

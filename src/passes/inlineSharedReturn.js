'use strict';

const CONDITIONAL_JUMPS = new Set([
  'ifeq', 'ifne', 'iflt', 'ifge', 'ifgt', 'ifle',
  'if_icmpeq', 'if_icmpne', 'if_icmplt', 'if_icmpge', 'if_icmpgt', 'if_icmple',
  'if_acmpeq', 'if_acmpne',
  'ifnull', 'ifnonnull',
]);

const INVERSE = {
  ifeq: 'ifne', ifne: 'ifeq',
  iflt: 'ifge', ifge: 'iflt',
  ifgt: 'ifle', ifle: 'ifgt',
  if_icmpeq: 'if_icmpne', if_icmpne: 'if_icmpeq',
  if_icmplt: 'if_icmpge', if_icmpge: 'if_icmplt',
  if_icmpgt: 'if_icmple', if_icmple: 'if_icmpgt',
  if_acmpeq: 'if_acmpne', if_acmpne: 'if_acmpeq',
  ifnull: 'ifnonnull', ifnonnull: 'ifnull',
};

function runInlineSharedReturn(astRoot, options = {}) {
  let fired = 0;
  for (const cls of astRoot.classes || []) {
    for (const item of cls.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      for (const attr of item.method.attributes || []) {
        if (!attr || attr.type !== 'code' || !attr.code) continue;
        fired += inlineMethod(attr.code.codeItems || [], {
          owner: cls.className,
          name: item.method.name,
          desc: item.method.descriptor,
          verbose: !!options.verbose,
          oncePerMethod: options.oncePerMethod,
        });
      }
    }
  }
  return { changed: fired > 0, fired };
}

function inlineMethod(codeItems, opts) {
  let fired = 0;
  const oncePerMethod = opts.oncePerMethod !== false;
  for (let i = 0; i < codeItems.length; i++) {
    const item = codeItems[i];
    const insn = item && item.instruction;
    const op = getOp(insn);
    if (!CONDITIONAL_JUMPS.has(op)) continue;
    const target = trimLabel(insn.arg);
    if (!target) continue;
    const targetIdx = findLabelIndex(codeItems, target);
    if (targetIdx < 0) continue;
    const fallthrough = nextInstructionLabel(codeItems, i);
    if (!fallthrough) continue;
    const body = extractNullReturnBody(codeItems, targetIdx);
    if (!body) continue;

    item.instruction = { ...insn, op: INVERSE[op], arg: fallthrough };
    const clone = body.map((entry) => cloneWithoutLabel(entry));
    codeItems.splice(i + 1, 0, ...clone);
    fired += 1;
    if (opts.verbose) {
      console.log(`[inline-return] ${opts.owner}.${opts.name}${opts.desc}: ${op} ${target}`);
    }
    if (oncePerMethod) return fired;
    i += clone.length;
  }
  return fired;
}

function extractNullReturnBody(codeItems, labelIdx) {
  const out = [];
  for (let i = labelIdx; i < codeItems.length && out.length < 6; i++) {
    const item = codeItems[i];
    if (!item) continue;
    out.push(item);
    const op = getOp(item.instruction);
    if (op === 'areturn') {
      const realOps = out.map((it) => getOp(it.instruction)).filter(Boolean);
      const ok =
        realOps.length >= 2 &&
        realOps[0] === 'aconst_null' &&
        realOps[realOps.length - 1] === 'areturn' &&
        (realOps.length === 2 || realOps.includes('monitorexit'));
      return ok ? out : null;
    }
    if (op && op !== 'aconst_null' && op !== 'aload' && op !== 'aload_0' &&
        op !== 'aload_1' && op !== 'aload_2' && op !== 'aload_3' && op !== 'monitorexit') {
      return null;
    }
  }
  return null;
}

function cloneWithoutLabel(item) {
  const clone = { ...item };
  delete clone.labelDef;
  delete clone.pc;
  if (item.instruction && typeof item.instruction === 'object') {
    clone.instruction = { ...item.instruction };
  }
  return clone;
}

function nextInstructionLabel(codeItems, idx) {
  for (let i = idx + 1; i < codeItems.length; i++) {
    const item = codeItems[i];
    if (!item) continue;
    if (item.instruction) return trimLabel(item.labelDef);
  }
  return null;
}

function countBranchPreds(codeItems, label) {
  let n = 0;
  for (const item of codeItems) {
    const insn = item && item.instruction;
    if (!insn || typeof insn !== 'object') continue;
    const op = getOp(insn);
    if ((CONDITIONAL_JUMPS.has(op) || op === 'goto') && trimLabel(insn.arg) === label) n += 1;
  }
  return n;
}

function findLabelIndex(codeItems, label) {
  for (let i = 0; i < codeItems.length; i++) {
    if (trimLabel(codeItems[i] && codeItems[i].labelDef) === label) return i;
  }
  return -1;
}

function trimLabel(label) {
  return typeof label === 'string' ? label.replace(/:$/, '') : null;
}

function getOp(insn) {
  if (!insn) return null;
  return typeof insn === 'string' ? insn : insn.op;
}

module.exports = { runInlineSharedReturn };

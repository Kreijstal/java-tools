'use strict';

function runNormalizeBooleanFieldOr(astRoot) {
  let rewrites = 0;
  for (const cls of astRoot.classes || []) {
    for (const item of cls.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      for (const attr of item.method.attributes || []) {
        const code = attr && attr.type === 'code' && attr.code;
        if (!code || !Array.isArray(code.codeItems)) continue;
        rewrites += rewriteCode(code);
      }
    }
  }
  return { changed: rewrites > 0, rewrites };
}

function rewriteCode(code) {
  const items = code.codeItems;
  const referenced = referencedLabels(code);
  let rewrites = 0;
  for (let i = 0; i + 5 < items.length; i += 1) {
    const receiver = aloadLocal(items[i]);
    if (receiver == null) continue;
    if (op(items[i + 1]) !== 'dup') continue;
    if (op(items[i + 2]) !== 'getfield') continue;
    const ref = arg(items[i + 2]);
    if (!isBooleanField(ref)) continue;
    if (iloadLocal(items[i + 3]) == null) continue;
    if (op(items[i + 4]) !== 'ior') continue;
    if (op(items[i + 5]) !== 'putfield' || !sameField(ref, arg(items[i + 5]))) continue;
    if (hasReferencedInteriorLabel(items, i + 1, i + 5, referenced)) continue;

    const done = freshLabel(items, 'L_bool_or_done');
    const firstLabel = items[i].labelDef;
    const intLoad = cloneWithoutLabel(items[i + 3]);
    intLoad.labelDef = firstLabel;
    items.splice(
      i,
      6,
      intLoad,
      { instruction: { op: 'ifeq', arg: done } },
      cloneWithoutLabel(items[i]),
      { instruction: 'iconst_1' },
      { instruction: cloneInstruction(items[i + 5]) },
      { labelDef: `${done}:`, instruction: 'nop' },
    );
    rewrites += 1;
    i += 5;
  }
  return rewrites;
}

function hasReferencedInteriorLabel(items, start, end, referenced) {
  for (let i = start; i <= end; i += 1) {
    if (referenced.has(trimLabel(items[i] && items[i].labelDef))) return true;
  }
  return false;
}

function cloneWithoutLabel(item) {
  return { instruction: cloneInstruction(item) };
}

function cloneInstruction(item) {
  const insn = item && item.instruction;
  if (!insn || typeof insn === 'string') return insn;
  return { ...insn };
}

function sameField(left, right) {
  return Array.isArray(left) && Array.isArray(right) &&
    left[0] === right[0] &&
    left[1] === right[1] &&
    Array.isArray(left[2]) &&
    Array.isArray(right[2]) &&
    left[2][0] === right[2][0] &&
    left[2][1] === right[2][1];
}

function isBooleanField(ref) {
  return Array.isArray(ref) && ref[0] === 'Field' && Array.isArray(ref[2]) && ref[2][1] === 'Z';
}

function freshLabel(items, prefix) {
  const used = new Set(items.map((item) => trimLabel(item && item.labelDef)).filter(Boolean));
  let n = 0;
  let label = prefix;
  while (used.has(label)) {
    n += 1;
    label = `${prefix}_${n}`;
  }
  return label;
}

function referencedLabels(code) {
  const out = new Set();
  for (const item of code.codeItems || []) {
    const itemOp = op(item);
    if ((itemOp && itemOp.startsWith('if')) || itemOp === 'goto' || itemOp === 'jsr') {
      out.add(trimLabel(arg(item)));
    }
    if (itemOp === 'tableswitch' || itemOp === 'lookupswitch') {
      const itemArg = arg(item);
      if (itemArg && typeof itemArg === 'object') {
        out.add(trimLabel(itemArg.default));
        for (const target of Object.values(itemArg.labels || {})) out.add(trimLabel(target));
      }
    }
  }
  for (const entry of code.exceptionTable || []) {
    out.add(trimLabel(entry.startLbl));
    out.add(trimLabel(entry.endLbl));
    out.add(trimLabel(entry.handlerLbl));
  }
  out.delete(null);
  return out;
}

function aloadLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'aload') return String(arg(item));
  const match = /^aload_([0-3])$/.exec(itemOp || '');
  return match ? match[1] : null;
}

function iloadLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'iload') return String(arg(item));
  const match = /^iload_([0-3])$/.exec(itemOp || '');
  return match ? match[1] : null;
}

function op(item) {
  const insn = item && item.instruction;
  return typeof insn === 'string' ? insn : insn && insn.op;
}

function arg(item) {
  const insn = item && item.instruction;
  return insn && typeof insn === 'object' ? insn.arg : null;
}

function trimLabel(label) {
  return typeof label === 'string' ? label.replace(/:$/, '') : null;
}

module.exports = { runNormalizeBooleanFieldOr, rewriteCode };

'use strict';

function runNormalizeDupStoreLoad(astRoot) {
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
  for (let i = 0; i + 1 < items.length; i += 1) {
    if (op(items[i]) !== 'dup') continue;
    const local = storeLocal(items[i + 1]);
    if (!local) continue;
    if (referenced.has(trimLabel(items[i + 1].labelDef))) continue;
    const load = loadForStore(op(items[i + 1]), local);
    if (!load) continue;

    const label = items[i].labelDef;
    items[i] = { ...items[i + 1], labelDef: label, instruction: cloneInstruction(items[i + 1]) };
    items[i + 1] = { instruction: load };
    rewrites += 1;
  }
  return rewrites;
}

function storeLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'fstore') return String(arg(item));
  const match = /^(f)store_([0-3])$/.exec(itemOp || '');
  return match ? match[2] : null;
}

function loadForStore(storeOp, local) {
  const prefix = storeOp === 'fstore' || /^fstore_/.test(storeOp || '') ? 'f' : null;
  if (!prefix) return null;
  const n = Number(local);
  if (Number.isInteger(n) && n >= 0 && n <= 3) return `${prefix}load_${n}`;
  return { op: `${prefix}load`, arg: String(local) };
}

function cloneInstruction(item) {
  const insn = item && item.instruction;
  if (!insn || typeof insn === 'string') return insn;
  return { ...insn };
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

module.exports = { runNormalizeDupStoreLoad, rewriteCode };

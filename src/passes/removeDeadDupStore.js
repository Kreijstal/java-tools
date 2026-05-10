'use strict';

function runRemoveDeadDupStore(astRoot) {
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
  const loaded = loadedLocals(items);
  const referenced = referencedLabels(code);
  let rewrites = 0;
  for (let i = 0; i + 2 < items.length; i += 1) {
    if (op(items[i]) !== 'dup') continue;
    const first = astoreLocal(items[i + 1]);
    const second = astoreLocal(items[i + 2]);
    if (first == null || second == null || first === second) continue;
    if (loaded.has(second)) continue;
    if (isReferencedLabel(items[i], referenced) || isReferencedLabel(items[i + 2], referenced)) continue;
    if (items[i].labelDef && !items[i + 1].labelDef) {
      items[i + 1].labelDef = items[i].labelDef;
    }
    items.splice(i + 2, 1);
    items.splice(i, 1);
    rewrites += 1;
    i -= 1;
  }
  return rewrites;
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

function isReferencedLabel(item, referenced) {
  const label = trimLabel(item && item.labelDef);
  return !!label && referenced.has(label);
}

function loadedLocals(items) {
  const out = new Set();
  for (const item of items) {
    const local = aloadLocal(item);
    if (local != null) out.add(local);
  }
  return out;
}

function aloadLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'aload') return String(arg(item));
  if (/^aload_[0-3]$/.test(itemOp || '')) return itemOp.slice(-1);
  return null;
}

function astoreLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'astore') return String(arg(item));
  if (/^astore_[0-3]$/.test(itemOp || '')) return itemOp.slice(-1);
  return null;
}

function op(item) {
  const insn = item && item.instruction;
  return typeof insn === 'string' ? insn : insn && insn.op;
}

function arg(item) {
  const insn = item && typeof item.instruction === 'object' ? item.instruction : null;
  return insn && insn.arg;
}

function trimLabel(label) {
  return typeof label === 'string' ? label.replace(/:$/, '') : null;
}

module.exports = {
  runRemoveDeadDupStore,
  rewriteCode,
};

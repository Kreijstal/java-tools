'use strict';

function runSplitArrayStoreLocalAssignment(astRoot) {
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
  let rewrites = 0;
  for (let i = 0; i + 2 < items.length; i += 1) {
    if (op(items[i]) !== 'dup_x2') continue;
    if (op(items[i + 1]) !== 'aastore') continue;
    const local = astoreLocal(items[i + 2]);
    if (local == null) continue;
    if (!hasImmediateSelfFieldStore(items, i + 3, local)) continue;

    items[i].instruction = 'dup';
    items[i + 1].instruction = storeRef(local);
    items[i + 2].instruction = 'aastore';
    rewrites += 1;
  }
  return rewrites;
}

function hasImmediateSelfFieldStore(items, start, local) {
  return aloadLocal(items[start]) === local &&
    aloadLocal(items[start + 1]) === local &&
    op(items[start + 2]) === 'checkcast' &&
    op(items[start + 3]) === 'putfield';
}

function storeRef(local) {
  const n = Number(local);
  if (Number.isInteger(n) && n >= 0 && n <= 3) return `astore_${n}`;
  return { op: 'astore', arg: String(local) };
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
  const insn = item && item.instruction;
  return insn && typeof insn === 'object' ? insn.arg : null;
}

module.exports = {
  runSplitArrayStoreLocalAssignment,
  rewriteCode,
};

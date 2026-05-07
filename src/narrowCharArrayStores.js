'use strict';

function runNarrowCharArrayStores(astRoot) {
  let rewrites = 0;
  for (const cls of astRoot.classes || []) {
    for (const item of cls.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      for (const attr of item.method.attributes || []) {
        const codeItems = attr && attr.type === 'code' && attr.code && attr.code.codeItems;
        if (!Array.isArray(codeItems)) continue;
        rewrites += narrowCodeItems(codeItems);
      }
    }
  }
  return { changed: rewrites > 0, rewrites };
}

function narrowCodeItems(codeItems) {
  let rewrites = 0;
  for (let i = 0; i <= codeItems.length - 7; i += 1) {
    const local = intLoadLocal(codeItems[i]);
    if (local == null) continue;
    if (intLoadLocal(codeItems[i + 1]) !== local) continue;
    if (op(codeItems[i + 2]) !== 'iconst_1') continue;
    if (op(codeItems[i + 3]) !== 'iadd') continue;
    if (op(codeItems[i + 4]) !== 'i2c') continue;
    if (intStoreLocal(codeItems[i + 5]) !== local) continue;
    if (op(codeItems[i + 6]) !== 'castore') continue;

    codeItems.splice(i + 6, 0, { instruction: 'i2c' });
    rewrites += 1;
    i += 6;
  }
  return rewrites;
}

function intLoadLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'iload') return String(arg(item));
  if (/^iload_[0-3]$/.test(itemOp || '')) return itemOp.slice(-1);
  return null;
}

function intStoreLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'istore') return String(arg(item));
  if (/^istore_[0-3]$/.test(itemOp || '')) return itemOp.slice(-1);
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

module.exports = { runNarrowCharArrayStores, narrowCodeItems };

'use strict';

function runNarrowCharArrayStores(astRoot) {
  let rewrites = 0;
  for (const cls of astRoot.classes || []) {
    for (const item of cls.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      for (const attr of item.method.attributes || []) {
        const codeItems = attr && attr.type === 'code' && attr.code && attr.code.codeItems;
        if (!Array.isArray(codeItems)) continue;
        rewrites += narrowCodeItems(codeItems, collectCharLocals(codeItems));
      }
    }
  }
  return { changed: rewrites > 0, rewrites };
}

function narrowCodeItems(codeItems, charLocals = collectCharLocals(codeItems)) {
  let rewrites = 0;
  for (let i = 0; i < codeItems.length; i += 1) {
    if (i <= codeItems.length - 2 && charLocals.has(intLoadLocal(codeItems[i])) && op(codeItems[i + 1]) === 'castore') {
      codeItems.splice(i + 1, 0, { instruction: 'i2c' });
      rewrites += 1;
      i += 1;
      continue;
    }
    if (i > codeItems.length - 7) continue;
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

function collectCharLocals(codeItems) {
  const locals = new Set();
  for (let i = 0; i < codeItems.length - 1; i += 1) {
    if (isCharProducer(codeItems[i]) && intStoreLocal(codeItems[i + 1]) != null) {
      locals.add(intStoreLocal(codeItems[i + 1]));
    }
  }
  return locals;
}

function isCharProducer(item) {
  const itemOp = op(item);
  const itemArg = arg(item);
  if (itemOp === 'caload') return true;
  if ((itemOp === 'getstatic' || itemOp === 'getfield') && fieldDescriptor(itemArg) === 'C') return true;
  if ((itemOp === 'invokevirtual' || itemOp === 'invokeinterface' || itemOp === 'invokestatic') && methodReturnsChar(itemArg)) return true;
  return false;
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

function methodReturnsChar(itemArg) {
  return Array.isArray(itemArg) &&
    (itemArg[0] === 'Method' || itemArg[0] === 'InterfaceMethod') &&
    Array.isArray(itemArg[2]) &&
    typeof itemArg[2][1] === 'string' &&
    itemArg[2][1].endsWith(')C');
}

function fieldDescriptor(itemArg) {
  return Array.isArray(itemArg) &&
    itemArg[0] === 'Field' &&
    Array.isArray(itemArg[2])
    ? itemArg[2][1]
    : null;
}

module.exports = { runNarrowCharArrayStores, narrowCodeItems, collectCharLocals };

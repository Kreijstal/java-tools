'use strict';

function runNarrowShortArrayStores(astRoot) {
  let rewrites = 0;
  for (const cls of astRoot.classes || []) {
    for (const item of cls.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      for (const attr of item.method.attributes || []) {
        const codeItems = attr && attr.type === 'code' && attr.code && attr.code.codeItems;
        if (!Array.isArray(codeItems)) continue;
        rewrites += narrowCodeItems(codeItems, item.method);
      }
    }
  }
  return { changed: rewrites > 0, rewrites };
}

function narrowCodeItems(codeItems, method = null) {
  let rewrites = 0;
  const shortArrayLocals = collectShortArrayLocals(codeItems, method);
  for (let i = 0; i <= codeItems.length - 2; i += 1) {
    if (op(codeItems[i + 1]) !== 'sastore') continue;
    if (!isNarrowableIntValue(codeItems[i])) continue;
    if (!hasKnownShortArrayProducer(codeItems, i, shortArrayLocals)) continue;
    codeItems.splice(i + 1, 0, { instruction: 'i2s' });
    rewrites += 1;
    i += 1;
  }
  return rewrites;
}

function collectShortArrayLocals(codeItems, method = null) {
  const locals = new Set(parameterLocals(method, '[S'));
  const arrayLocals = new Set(parameterLocals(method, '[[S'));
  for (let i = 0; i < codeItems.length - 1; i += 1) {
    if (isShortArrayProducer(codeItems[i]) && objectStoreLocal(codeItems[i + 1]) != null) {
      locals.add(objectStoreLocal(codeItems[i + 1]));
    }
    if (isShortArrayArrayProducer(codeItems[i]) && objectStoreLocal(codeItems[i + 1]) != null) {
      arrayLocals.add(objectStoreLocal(codeItems[i + 1]));
    }
  }
  return { shortArrays: locals, shortArrayArrays: arrayLocals };
}

function hasKnownShortArrayProducer(codeItems, valueIndex, knownLocals) {
  for (let i = Math.max(0, valueIndex - 24); i < valueIndex; i += 1) {
    const item = codeItems[i];
    const local = objectLoadLocal(item);
    if (local != null && knownLocals.shortArrays.has(local)) return true;
    if (op(item) === 'aaload' && isKnownShortArrayArrayLoad(codeItems, i, knownLocals.shortArrayArrays)) return true;
    if (isShortArrayProducer(item)) return true;
  }
  return false;
}

function isKnownShortArrayArrayLoad(codeItems, i, shortArrayArrayLocals) {
  for (let j = Math.max(0, i - 3); j < i; j += 1) {
    const local = objectLoadLocal(codeItems[j]);
    if (local != null && shortArrayArrayLocals.has(local)) return true;
    if (isShortArrayArrayProducer(codeItems[j])) return true;
  }
  return false;
}

function isShortArrayProducer(item) {
  const itemOp = op(item);
  const itemArg = arg(item);
  if (itemOp === 'newarray' && itemArg === 'short') return true;
  if ((itemOp === 'getstatic' || itemOp === 'getfield') && fieldDescriptor(itemArg) === '[S') return true;
  if ((itemOp === 'invokevirtual' || itemOp === 'invokeinterface' || itemOp === 'invokestatic') && methodReturns(itemArg, '()[S')) return true;
  return false;
}

function isShortArrayArrayProducer(item) {
  const itemOp = op(item);
  const itemArg = arg(item);
  if (itemOp === 'anewarray' && itemArg === '[S') return true;
  if ((itemOp === 'getstatic' || itemOp === 'getfield') && fieldDescriptor(itemArg) === '[[S') return true;
  if ((itemOp === 'invokevirtual' || itemOp === 'invokeinterface' || itemOp === 'invokestatic') && methodReturns(itemArg, '()[[S')) return true;
  return false;
}

function isNarrowableIntValue(item) {
  const itemOp = op(item);
  if (itemOp === 'i2s') return false;
  if (itemOp === 'saload') return false;
  return pushValue(item) != null || intLoadLocal(item) != null;
}

function objectLoadLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'aload') return String(arg(item));
  if (/^aload_[0-3]$/.test(itemOp || '')) return itemOp.slice(-1);
  return null;
}

function objectStoreLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'astore') return String(arg(item));
  if (/^astore_[0-3]$/.test(itemOp || '')) return itemOp.slice(-1);
  return null;
}

function intLoadLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'iload') return String(arg(item));
  if (/^iload_[0-3]$/.test(itemOp || '')) return itemOp.slice(-1);
  return null;
}

function pushValue(item) {
  const itemOp = op(item);
  if (itemOp === 'iconst_m1') return -1;
  if (/^iconst_[0-5]$/.test(itemOp || '')) return Number(itemOp.slice(-1));
  if (itemOp === 'bipush' || itemOp === 'sipush') return Number(arg(item));
  return null;
}

function parameterLocals(method, descriptor) {
  const out = [];
  if (!method || typeof method.descriptor !== 'string') return out;
  let local = method.flags && method.flags.includes('static') ? 0 : 1;
  const params = parseParameterDescriptors(method.descriptor);
  for (const desc of params) {
    if (desc === descriptor) out.push(String(local));
    local += (desc === 'J' || desc === 'D') ? 2 : 1;
  }
  return out;
}

function parseParameterDescriptors(descriptor) {
  const close = descriptor.indexOf(')');
  if (!descriptor.startsWith('(') || close < 0) return [];
  const params = [];
  for (let i = 1; i < close;) {
    const start = i;
    while (descriptor[i] === '[') i += 1;
    if (descriptor[i] === 'L') {
      const semi = descriptor.indexOf(';', i);
      if (semi < 0 || semi > close) return params;
      params.push(descriptor.slice(start, semi + 1));
      i = semi + 1;
    } else {
      params.push(descriptor.slice(start, i + 1));
      i += 1;
    }
  }
  return params;
}

function methodReturns(itemArg, descriptor) {
  return Array.isArray(itemArg) &&
    (itemArg[0] === 'Method' || itemArg[0] === 'InterfaceMethod') &&
    Array.isArray(itemArg[2]) &&
    itemArg[2][1] === descriptor;
}

function fieldDescriptor(itemArg) {
  return Array.isArray(itemArg) &&
    itemArg[0] === 'Field' &&
    Array.isArray(itemArg[2])
    ? itemArg[2][1]
    : null;
}

function op(item) {
  const insn = item && item.instruction;
  return typeof insn === 'string' ? insn : insn && insn.op;
}

function arg(item) {
  const insn = item && item.instruction;
  return insn && typeof insn === 'object' ? insn.arg : null;
}

module.exports = { runNarrowShortArrayStores, narrowCodeItems, collectShortArrayLocals };

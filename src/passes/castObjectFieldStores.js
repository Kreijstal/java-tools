'use strict';

function runCastObjectFieldStores(astRoot) {
  let rewrites = 0;
  for (const cls of astRoot.classes || []) {
    for (const item of cls.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      for (const attr of item.method.attributes || []) {
        const codeItems = attr && attr.type === 'code' && attr.code && attr.code.codeItems;
        if (!Array.isArray(codeItems)) continue;
        rewrites += castCodeItems(codeItems);
      }
    }
  }
  return { changed: rewrites > 0, rewrites };
}

function castCodeItems(codeItems) {
  let rewrites = 0;
  for (let i = 1; i < codeItems.length; i += 1) {
    const itemOp = op(codeItems[i]);
    if (itemOp !== 'putstatic' && itemOp !== 'putfield') continue;

    const target = checkcastTarget(fieldDescriptor(arg(codeItems[i])));
    if (target == null) continue;
    const local = aloadLocal(codeItems[i - 1]);
    if (local == null) continue;
    if (op(codeItems[i - 2]) === 'checkcast') continue;
    if (!localConstructedAs(codeItems, i - 1, local, target)) continue;

    codeItems.splice(i, 0, { instruction: { op: 'checkcast', arg: target } });
    rewrites += 1;
    i += 1;
  }
  return rewrites;
}

function localConstructedAs(codeItems, beforeIndex, local, target) {
  if (!isObjectClassName(target)) return false;
  for (let i = beforeIndex - 1; i >= 0; i -= 1) {
    if (storeLocal(codeItems[i]) !== local) continue;
    const start = Math.max(0, i - 40);
    for (let j = i - 1; j >= start; j -= 1) {
      if (isConstructorCall(codeItems[j], target)) {
        return hasNewBetween(codeItems, target, start, j);
      }
    }
    return false;
  }
  return false;
}

function hasNewBetween(codeItems, target, start, end) {
  for (let i = end; i >= start; i -= 1) {
    if (op(codeItems[i]) === 'new' && arg(codeItems[i]) === target) return true;
  }
  return false;
}

function isConstructorCall(item, target) {
  const itemOp = op(item);
  const itemArg = arg(item);
  return itemOp === 'invokespecial' &&
    Array.isArray(itemArg) &&
    itemArg[0] === 'Method' &&
    itemArg[1] === target &&
    Array.isArray(itemArg[2]) &&
    itemArg[2][0] === '<init>';
}

function isObjectClassName(target) {
  return typeof target === 'string' && !target.startsWith('[');
}

function checkcastTarget(descriptor) {
  if (typeof descriptor !== 'string') return null;
  if (descriptor.startsWith('L') && descriptor.endsWith(';')) {
    return descriptor.slice(1, -1);
  }
  if (descriptor.startsWith('[')) {
    return descriptor;
  }
  return null;
}

function aloadLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'aload') return String(arg(item));
  if (/^aload_[0-3]$/.test(itemOp || '')) return itemOp.slice(-1);
  return null;
}

function storeLocal(item) {
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

function fieldDescriptor(itemArg) {
  return Array.isArray(itemArg) &&
    itemArg[0] === 'Field' &&
    Array.isArray(itemArg[2])
    ? itemArg[2][1]
    : null;
}

module.exports = { runCastObjectFieldStores, castCodeItems, checkcastTarget, localConstructedAs };

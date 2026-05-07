'use strict';

const BOOL_BRANCHES = new Set(['ifeq', 'ifne']);

function runInlineSingleUseBooleanBranch(astRoot) {
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
    if (!isBooleanProducingCall(items[i - 1])) continue;
    const local = istoreLocal(items[i]);
    if (local == null) continue;
    if (iloadLocal(items[i + 1]) !== local) continue;
    const branchOp = op(items[i + 2]);
    if (!BOOL_BRANCHES.has(branchOp)) continue;
    if (hasReadBeforeOverwrite(items, i + 3, local)) continue;

    if (items[i].labelDef) {
      items[i + 2].labelDef = items[i + 2].labelDef || items[i].labelDef;
    } else if (items[i + 1].labelDef) {
      items[i + 2].labelDef = items[i + 2].labelDef || items[i + 1].labelDef;
    }
    items.splice(i, 2);
    rewrites += 1;
  }
  return rewrites;
}

function isBooleanProducingCall(item) {
  const itemOp = op(item);
  if (itemOp !== 'invokestatic' && itemOp !== 'invokevirtual' && itemOp !== 'invokeinterface' && itemOp !== 'invokespecial') {
    return false;
  }
  const itemArg = arg(item);
  return Array.isArray(itemArg) &&
    itemArg[0] === 'Method' &&
    itemArg[1] === 'mb' &&
    Array.isArray(itemArg[2]) &&
    itemArg[2][0] === 'a' &&
    itemArg[2][1] === '(ZI)Z';
}

function hasReadBeforeOverwrite(items, start, local) {
  for (let i = start; i < items.length; i += 1) {
    if (iloadLocal(items[i]) === local) return true;
    if (istoreLocal(items[i]) === local) return false;
  }
  return false;
}

function iloadLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'iload') return String(arg(item));
  if (/^iload_[0-3]$/.test(itemOp || '')) return itemOp.slice(-1);
  return null;
}

function istoreLocal(item) {
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

module.exports = {
  runInlineSingleUseBooleanBranch,
  rewriteCode,
};

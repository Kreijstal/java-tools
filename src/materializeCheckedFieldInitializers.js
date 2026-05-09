'use strict';

function runMaterializeCheckedFieldInitializers(astRoot) {
  let rewrites = 0;
  for (const cls of astRoot.classes || []) {
    for (const item of cls.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      if (item.method.name !== '<init>' || !hasExceptionsAttribute(item.method)) continue;
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
  for (let i = 0; i < items.length; i += 1) {
    if (!isAload0(items[i])) continue;
    const newIndex = nextInstructionIndex(items, i);
    const dupIndex = nextInstructionIndex(items, newIndex);
    const initIndex = nextInstructionIndex(items, dupIndex);
    const putIndex = nextInstructionIndex(items, initIndex);
    if (newIndex < 0 || dupIndex < 0 || initIndex < 0 || putIndex < 0) continue;
    if (op(items[newIndex]) !== 'new' || op(items[dupIndex]) !== 'dup') continue;
    if (op(items[initIndex]) !== 'invokespecial' || op(items[putIndex]) !== 'putfield') continue;
    const field = arg(items[putIndex]);
    const desc = fieldDescriptor(field);
    if (!isReferenceDescriptor(desc)) continue;
    if (hasPriorNullWrite(items, i, field)) continue;
    const fresh = allocateLocal(code);
    const originalLabel = items[i].labelDef;
    const newItem = cloneItem(items[newIndex]);
    newItem.labelDef = originalLabel;
    const dupItem = cloneItem(items[dupIndex]);
    const initItem = cloneItem(items[initIndex]);
    const putItem = cloneItem(items[putIndex]);
    items.splice(
      i,
      putIndex - i + 1,
      newItem,
      dupItem,
      initItem,
      { instruction: storeRef(fresh) },
      { instruction: 'aload_0' },
      { instruction: loadRef(fresh) },
      putItem,
    );
    return 1;
  }
  return 0;
}

function hasExceptionsAttribute(method) {
  return (method.attributes || []).some((attr) => attr && attr.type === 'exceptions');
}

function hasPriorNullWrite(items, beforeIndex, field) {
  for (let i = 0; i + 2 < beforeIndex; i += 1) {
    if (!isAload0(items[i]) || op(items[i + 1]) !== 'aconst_null' || op(items[i + 2]) !== 'putfield') continue;
    if (sameField(arg(items[i + 2]), field)) return true;
  }
  return false;
}

function sameField(a, b) {
  return Array.isArray(a) && Array.isArray(b) &&
    a[0] === b[0] && a[1] === b[1] &&
    Array.isArray(a[2]) && Array.isArray(b[2]) &&
    a[2][0] === b[2][0] && a[2][1] === b[2][1];
}

function cloneArg(value) {
  return Array.isArray(value) ? value.map(cloneArg) : value;
}

function cloneItem(item) {
  const out = { ...item };
  if (item && typeof item.instruction === 'object') {
    out.instruction = { ...item.instruction, arg: cloneArg(item.instruction.arg) };
  }
  return out;
}

function allocateLocal(code) {
  const declared = Number(code.locals || code.localsSize || 0);
  const current = Math.max(declared, maxReferencedLocal(code.codeItems || []) + 1);
  const next = String(current + 1);
  if ('locals' in code) code.locals = next;
  else code.localsSize = next;
  return String(current);
}

function maxReferencedLocal(items) {
  let max = -1;
  for (const item of items) {
    const itemOp = op(item);
    const explicit = localArg(item);
    if (explicit != null) max = Math.max(max, Number(explicit));
    const short = /^(?:[ilfda](?:load|store))_([0-3])$/.exec(itemOp || '');
    if (short) max = Math.max(max, Number(short[1]));
  }
  return max;
}

function localArg(item) {
  const itemOp = op(item);
  if (/^[ilfda](?:load|store)$/.test(itemOp || '')) return String(arg(item));
  return null;
}

function loadRef(local) {
  const n = Number(local);
  if (Number.isInteger(n) && n >= 0 && n <= 3) return `aload_${n}`;
  return { op: 'aload', arg: String(local) };
}

function storeRef(local) {
  const n = Number(local);
  if (Number.isInteger(n) && n >= 0 && n <= 3) return `astore_${n}`;
  return { op: 'astore', arg: String(local) };
}

function fieldDescriptor(field) {
  return Array.isArray(field) && Array.isArray(field[2]) ? field[2][1] : null;
}

function isReferenceDescriptor(desc) {
  return typeof desc === 'string' && (desc.startsWith('L') || desc.startsWith('['));
}

function isAload0(item) {
  return op(item) === 'aload_0' || (op(item) === 'aload' && String(arg(item)) === '0');
}

function nextInstructionIndex(items, index) {
  if (index < 0) return -1;
  for (let i = index + 1; i < items.length; i += 1) {
    if (items[i] && items[i].instruction) return i;
  }
  return -1;
}

function op(item) {
  const insn = item && item.instruction;
  return typeof insn === 'string' ? insn : insn && insn.op;
}

function arg(item) {
  const insn = item && typeof item.instruction === 'object' ? item.instruction : null;
  return insn && insn.arg;
}

module.exports = {
  runMaterializeCheckedFieldInitializers,
  rewriteCode,
};

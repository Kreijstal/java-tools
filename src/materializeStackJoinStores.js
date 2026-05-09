'use strict';

const STORE_OPS = new Set(['istore', 'lstore', 'fstore', 'dstore', 'astore']);

function runMaterializeStackJoinStores(astRoot) {
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
  if (items.length > 10000) return 0;
  let rewrites = 0;

  for (let i = 0; i < items.length; i += 1) {
    const joinLabel = trimLabel(items[i] && items[i].labelDef);
    const store = storeInstruction(items[i]);
    if (!joinLabel || !store) continue;
    if (store.kind !== 'a') continue;
    const rangeEnd = nextSameLocalWrite(items, i + 1, store.local);
    if (hasPrimitiveWrite(items, store.local, i + 1, rangeEnd < 0 ? items.length : rangeEnd)) continue;
    if (isExceptionTableLabel(code.exceptionTable, joinLabel)) continue;

    const refs = branchReferences(items, joinLabel);
    const gotoRefs = refs.filter((ref) => ref.op === 'goto' && ref.index < i);
    if (gotoRefs.length < 2 || gotoRefs.length !== refs.length) continue;
    if (previousInstructionIndex(items, i) < 0) continue;

    const afterIndex = nextInstructionIndex(items, i);
    if (afterIndex < 0) continue;
    const afterLabel = ensureLabel(items, afterIndex);
    if (!afterLabel) continue;

    let ok = true;
    for (const ref of gotoRefs) {
      const producerIndex = previousInstructionIndex(items, ref.index);
      if (producerIndex < 0 || !isCompatibleProducer(items[producerIndex], store.kind)) {
        ok = false;
        break;
      }
      const sourceLabel = trimLabel(items[ref.index] && items[ref.index].labelDef);
      if (sourceLabel && branchReferences(items, sourceLabel).length > 0) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    for (const ref of gotoRefs.sort((a, b) => b.index - a.index)) {
      items.splice(ref.index, 0, { instruction: makeStore(store.kind, store.local) });
      const gotoItem = items[ref.index + 1];
      gotoItem.instruction = { ...gotoItem.instruction, arg: afterLabel };
      rewrites += 1;
      if (ref.index < i) i += 1;
    }
  }

  return rewrites;
}

function hasPrimitiveWrite(items, local, start, end) {
  for (let i = start; i < end; i += 1) {
    const item = items[i];
    const store = storeInstruction(item);
    if (store && store.local === String(local) && store.kind !== 'a') return true;
    if (iincLocal(item) === String(local)) return true;
  }
  return false;
}

function nextSameLocalWrite(items, start, local) {
  for (let i = start; i < items.length; i += 1) {
    const store = storeInstruction(items[i]);
    if (store && store.local === String(local)) return i;
    if (iincLocal(items[i]) === String(local)) return i;
  }
  return -1;
}

function iincLocal(item) {
  if (op(item) !== 'iinc') return null;
  const value = arg(item);
  if (Array.isArray(value)) return String(value[0]);
  if (value && typeof value === 'object' && value.local != null) return String(value.local);
  if (typeof value === 'string') return value.split(/\s+/)[0];
  return null;
}

function storeInstruction(item) {
  const itemOp = op(item);
  if (STORE_OPS.has(itemOp)) return { kind: itemOp[0], local: String(arg(item)) };
  const match = /^([ilfda])store_([0-3])$/.exec(itemOp || '');
  return match ? { kind: match[1], local: match[2] } : null;
}

function makeStore(kind, local) {
  const n = Number(local);
  if (Number.isInteger(n) && n >= 0 && n <= 3) return `${kind}store_${n}`;
  return { op: `${kind}store`, arg: String(local) };
}

function isCompatibleProducer(item, kind) {
  const itemOp = op(item);
  if (!itemOp) return false;
  if (kind === 'a') {
    if (itemOp === 'aconst_null' || itemOp === 'aaload' || itemOp === 'checkcast' || itemOp === 'new') return true;
    if (itemOp === 'getstatic' || itemOp === 'getfield') return isReferenceDescriptor(fieldDescriptor(item));
    if (/^aload(?:_[0-3])?$/.test(itemOp)) return true;
    if (/^invoke/.test(itemOp)) return isReferenceDescriptor(invokeReturnDescriptor(item));
    return false;
  }
  if (kind === 'i') {
    return itemOp === 'iaload' || itemOp === 'baload' || itemOp === 'caload' || itemOp === 'saload' ||
      /^iload(?:_[0-3])?$/.test(itemOp) ||
      /^iconst_(?:m1|[0-5])$/.test(itemOp) ||
      itemOp === 'bipush' || itemOp === 'sipush' || itemOp === 'ldc' ||
      /^i(?:add|sub|mul|div|rem|and|or|xor|shl|shr|ushr|neg)$/.test(itemOp) ||
      itemOp === 'i2b' || itemOp === 'i2c' || itemOp === 'i2s' ||
      ((itemOp === 'getstatic' || itemOp === 'getfield') && isIntLikeDescriptor(fieldDescriptor(item))) ||
      (/^invoke/.test(itemOp) && isIntLikeDescriptor(invokeReturnDescriptor(item)));
  }
  if (kind === 'l') {
    return itemOp === 'laload' || /^lload(?:_[0-3])?$/.test(itemOp) ||
      /^lconst_[0-1]$/.test(itemOp) || itemOp === 'ldc2_w' ||
      /^l(?:add|sub|mul|div|rem|and|or|xor|shl|shr|ushr|neg)$/.test(itemOp) ||
      ((itemOp === 'getstatic' || itemOp === 'getfield') && fieldDescriptor(item) === 'J') ||
      (/^invoke/.test(itemOp) && invokeReturnDescriptor(item) === 'J');
  }
  if (kind === 'f') {
    return itemOp === 'faload' || /^fload(?:_[0-3])?$/.test(itemOp) ||
      /^fconst_[0-2]$/.test(itemOp) || itemOp === 'ldc' ||
      /^f(?:add|sub|mul|div|rem|neg)$/.test(itemOp) ||
      ((itemOp === 'getstatic' || itemOp === 'getfield') && fieldDescriptor(item) === 'F') ||
      (/^invoke/.test(itemOp) && invokeReturnDescriptor(item) === 'F');
  }
  if (kind === 'd') {
    return itemOp === 'daload' || /^dload(?:_[0-3])?$/.test(itemOp) ||
      /^dconst_[0-1]$/.test(itemOp) || itemOp === 'ldc2_w' ||
      /^d(?:add|sub|mul|div|rem|neg)$/.test(itemOp) ||
      ((itemOp === 'getstatic' || itemOp === 'getfield') && fieldDescriptor(item) === 'D') ||
      (/^invoke/.test(itemOp) && invokeReturnDescriptor(item) === 'D');
  }
  return false;
}

function fieldDescriptor(item) {
  const value = arg(item);
  return Array.isArray(value) && Array.isArray(value[2]) ? value[2][1] : null;
}

function invokeReturnDescriptor(item) {
  const value = arg(item);
  const desc = Array.isArray(value) && Array.isArray(value[2]) ? value[2][1] : null;
  if (typeof desc !== 'string') return null;
  const close = desc.lastIndexOf(')');
  return close >= 0 ? desc.slice(close + 1) : null;
}

function isReferenceDescriptor(desc) {
  return typeof desc === 'string' && (desc.startsWith('L') || desc.startsWith('['));
}

function isIntLikeDescriptor(desc) {
  return desc === 'I' || desc === 'Z' || desc === 'B' || desc === 'C' || desc === 'S';
}

function branchReferences(items, label) {
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    const itemOp = op(items[i]);
    const itemArg = arg(items[i]);
    if (typeof itemArg === 'string' && trimLabel(itemArg) === label) {
      out.push({ index: i, op: itemOp });
    }
  }
  return out;
}

function ensureLabel(items, index) {
  const existing = trimLabel(items[index] && items[index].labelDef);
  if (existing) return existing;
  const used = new Set();
  for (const item of items) {
    const label = trimLabel(item && item.labelDef);
    if (label) used.add(label);
  }
  let n = 0;
  let label = 'Lstack_join_after';
  while (used.has(label)) {
    n += 1;
    label = `Lstack_join_after_${n}`;
  }
  items[index].labelDef = `${label}:`;
  return label;
}

function isExceptionTableLabel(exceptionTable, label) {
  return (exceptionTable || []).some((entry) =>
    trimLabel(entry.startLbl) === label ||
    trimLabel(entry.endLbl) === label ||
    trimLabel(entry.handlerLbl) === label);
}

function previousInstructionIndex(items, index) {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (items[i] && items[i].instruction) return i;
  }
  return -1;
}

function nextInstructionIndex(items, index) {
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

function trimLabel(label) {
  return typeof label === 'string' ? label.replace(/:$/, '') : null;
}

module.exports = {
  runMaterializeStackJoinStores,
  rewriteCode,
};

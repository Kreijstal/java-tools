'use strict';

function runMaterializeBranchJoinReferenceLocals(astRoot, options = {}) {
  let rewrites = 0;
  for (const cls of astRoot.classes || []) {
    for (const item of cls.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      for (const attr of item.method.attributes || []) {
        const code = attr && attr.type === 'code' && attr.code;
        if (!code || !Array.isArray(code.codeItems)) continue;
        rewrites += materializeCode(code, options);
      }
    }
  }
  return { changed: rewrites > 0, rewrites };
}

function materializeCode(code, options = {}) {
  const items = code.codeItems;
  const insertions = [];
  const maxInsertions = options.maxInsertions || 32;
  for (let i = 0; i < items.length; i += 1) {
    if (op(items[i]) !== 'goto') continue;
    const join = findLabel(items, arg(items[i]));
    if (join <= i + 1) continue;
    const joinUse = firstReferenceLoadBeforeWrite(items, join, 24);
    if (!joinUse) continue;
    const elseStore = findReferenceStoreToLocal(items, i + 1, join, joinUse.local);
    if (!elseStore) continue;
    const sourceStore = findPriorReferenceStore(items, i - 1, Math.max(0, i - 80), elseStore.desc, joinUse.local);
    if (!sourceStore) continue;
    if (localWrittenBetween(items, sourceStore.index + 1, i, sourceStore.local)) continue;
    if (localWrittenBetween(items, sourceStore.index + 1, i, joinUse.local)) continue;
    insertions.push({ index: i, sourceLocal: sourceStore.local, targetLocal: joinUse.local });
  }
  if (insertions.length === 0 || insertions.length > maxInsertions) return 0;
  for (const insertion of insertions.sort((a, b) => b.index - a.index)) {
    items.splice(
      insertion.index,
      0,
      { instruction: loadRef(insertion.sourceLocal) },
      { instruction: storeRef(insertion.targetLocal) },
    );
  }
  return insertions.length;
}

function firstReferenceLoadBeforeWrite(items, start, maxSeen) {
  for (let i = start, seen = 0; i < items.length && seen < maxSeen; i += 1, seen += 1) {
    const loaded = aloadLocal(items[i]);
    if (loaded != null) return { index: i, local: loaded };
    if (astoreLocal(items[i]) != null || primitiveStoreLocal(items[i]) != null) return null;
    const itemOp = op(items[i]);
    if (itemOp && /^(?:if|goto|return|athrow)/.test(itemOp)) return null;
  }
  return null;
}

function findReferenceStoreToLocal(items, start, end, local) {
  for (let i = start; i < end; i += 1) {
    if (astoreLocal(items[i]) !== local) continue;
    const desc = referenceProducerDescriptor(items, i);
    if (desc) return { index: i, local, desc };
  }
  return null;
}

function findPriorReferenceStore(items, start, min, desc, excludeLocal) {
  for (let i = start; i >= min; i -= 1) {
    const local = astoreLocal(items[i]);
    if (local == null || local === excludeLocal) continue;
    if (referenceProducerDescriptor(items, i) === desc) return { index: i, local, desc };
  }
  return null;
}

function referenceProducerDescriptor(items, storeIndex) {
  const prev = previousInstructionIndex(items, storeIndex);
  if (prev < 0) return null;
  const itemOp = op(items[prev]);
  if (itemOp === 'checkcast') return referenceDescriptorFromClassName(arg(items[prev]));
  if (itemOp === 'aaload') return 'Ljava/lang/Object;';
  if (itemOp === 'new') return referenceDescriptorFromClassName(arg(items[prev]));
  if (/^invoke/.test(itemOp || '')) {
    const ref = arg(items[prev]);
    const desc = Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
    const ret = returnDescriptor(desc);
    return isReferenceDescriptor(ret) ? ret : null;
  }
  if (aloadLocal(items[prev]) != null) {
    return localStoreDescriptorBefore(items, prev - 1, aloadLocal(items[prev]));
  }
  return null;
}

function localStoreDescriptorBefore(items, start, local) {
  for (let i = start; i >= 0; i -= 1) {
    if (primitiveStoreLocal(items[i]) === local) return null;
    if (astoreLocal(items[i]) === local) return referenceProducerDescriptor(items, i);
  }
  return null;
}

function localWrittenBetween(items, start, end, local) {
  for (let i = start; i < end; i += 1) {
    if (astoreLocal(items[i]) === local || primitiveStoreLocal(items[i]) === local || iincLocal(items[i]) === local) return true;
  }
  return false;
}

function returnDescriptor(desc) {
  if (typeof desc !== 'string') return null;
  const idx = desc.lastIndexOf(')');
  return idx >= 0 ? desc.slice(idx + 1) : null;
}

function isReferenceDescriptor(desc) {
  return typeof desc === 'string' && (desc.startsWith('L') || desc.startsWith('['));
}

function referenceDescriptorFromClassName(value) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('[')) return value;
  return `L${value};`;
}

function findLabel(items, label) {
  const target = trimLabel(label);
  if (!target) return -1;
  for (let i = 0; i < items.length; i += 1) {
    if (trimLabel(items[i] && items[i].labelDef) === target) return i;
  }
  return -1;
}

function previousInstructionIndex(items, index) {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (items[i] && items[i].instruction) return i;
  }
  return -1;
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

function aloadLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'aload') return String(arg(item));
  const match = /^aload_([0-3])$/.exec(itemOp || '');
  return match ? match[1] : null;
}

function astoreLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'astore') return String(arg(item));
  const match = /^astore_([0-3])$/.exec(itemOp || '');
  return match ? match[1] : null;
}

function primitiveStoreLocal(item) {
  const itemOp = op(item);
  if (/^[ilfd]store$/.test(itemOp || '')) return String(arg(item));
  const match = /^[ilfd]store_([0-3])$/.exec(itemOp || '');
  return match ? match[1] : null;
}

function iincLocal(item) {
  if (op(item) !== 'iinc') return null;
  const value = arg(item);
  return typeof value === 'number' || typeof value === 'string' ? String(value).split(/\s+/)[0] : null;
}

function trimLabel(label) {
  return typeof label === 'string' ? label.replace(/:$/, '') : null;
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
  runMaterializeBranchJoinReferenceLocals,
  materializeCode,
};

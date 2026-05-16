'use strict';

function runMaterializeSkippedStringLocals(astRoot, options = {}) {
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
  const maxInsertions = options.maxInsertions || 16;
  for (let i = 0; i < items.length; i += 1) {
    const baseLocal = astoreLocal(items[i]);
    if (baseLocal == null || producedDescriptorForStore(items, i) !== 'Ljava/lang/String;') continue;
    const candidate = findSkippedStringCandidate(items, i + 1, baseLocal);
    if (!candidate) continue;
    insertions.push({ index: i + 1, baseLocal, targetLocal: candidate.targetLocal });
  }
  if (insertions.length === 0 || insertions.length > maxInsertions) return 0;
  for (const insertion of insertions.sort((a, b) => b.index - a.index)) {
    items.splice(insertion.index, 0, { instruction: loadRef(insertion.baseLocal) }, { instruction: storeRef(insertion.targetLocal) });
  }
  return insertions.length;
}

function findSkippedStringCandidate(items, start, baseLocal) {
  for (let i = start, seen = 0; i < items.length && seen < 32; i += 1, seen += 1) {
    const itemOp = op(items[i]);
    if (!itemOp) continue;
    if (astoreLocal(items[i]) === baseLocal) return null;
    if (!itemOp.startsWith('if')) continue;
    const target = trimLabel(arg(items[i]));
    if (!target) continue;
    const targetIndex = findLabel(items, target);
    if (targetIndex < 0 || targetIndex <= i) continue;
    const targetLocal = findStringStoreBefore(items, i + 1, targetIndex);
    if (targetLocal == null || targetLocal === baseLocal) continue;
    if (isStringLocalUsedAfter(items, targetIndex, targetLocal)) return { targetLocal };
  }
  return null;
}

function findStringStoreBefore(items, start, end) {
  let found = null;
  for (let i = start; i < end; i += 1) {
    const local = astoreLocal(items[i]);
    if (local == null) continue;
    if (producedDescriptorForStore(items, i) !== 'Ljava/lang/String;') continue;
    found = local;
  }
  return found;
}

function isStringLocalUsedAfter(items, start, local) {
  for (let i = start; i < items.length; i += 1) {
    if (astoreLocal(items[i]) === local) return false;
    if (primitiveStoreLocal(items[i]) === local || iincLocal(items[i]) === local) return false;
    if (aloadLocal(items[i]) !== local) continue;
    return isStringUse(items, i);
  }
  return false;
}

function isStringUse(items, loadIndex) {
  for (let i = nextInstructionIndex(items, loadIndex), seen = 0;
    i >= 0 && seen < 8;
    i = nextInstructionIndex(items, i), seen += 1) {
    const itemOp = op(items[i]);
    if (/^invoke/.test(itemOp || '')) {
      const ref = arg(items[i]);
      const desc = Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
      return typeof desc === 'string' && desc.includes('Ljava/lang/String;');
    }
    if (!isSimpleStackProducer(items[i])) return false;
  }
  return false;
}

function producedDescriptorForStore(items, storeIndex) {
  const prev = previousInstructionIndex(items, storeIndex);
  if (prev < 0) return null;
  const itemOp = op(items[prev]);
  if (itemOp === 'checkcast') return referenceDescriptorFromClassName(arg(items[prev]));
  if (/^invoke/.test(itemOp || '')) {
    const ref = arg(items[prev]);
    const desc = Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
    return returnDescriptor(desc);
  }
  return null;
}

function isSimpleStackProducer(item) {
  const itemOp = op(item);
  return /^(?:a|i|l|f|d)load(?:_[0-3])?$/.test(itemOp || '') ||
    /^(?:aconst_null|iconst_m1|iconst_[0-5]|lconst_[0-1]|fconst_[0-2]|dconst_[0-1])$/.test(itemOp || '') ||
    itemOp === 'bipush' || itemOp === 'sipush' || itemOp === 'ldc' || itemOp === 'ldc_w' || itemOp === 'ldc2_w' ||
    itemOp === 'getstatic' || itemOp === 'getfield' ||
    itemOp === 'iadd' || itemOp === 'isub' || itemOp === 'ishr' || itemOp === 'ineg';
}

function returnDescriptor(desc) {
  if (typeof desc !== 'string') return null;
  const idx = desc.lastIndexOf(')');
  return idx >= 0 ? desc.slice(idx + 1) : null;
}

function referenceDescriptorFromClassName(value) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('[')) return value;
  return `L${value};`;
}

function findLabel(items, label) {
  for (let i = 0; i < items.length; i += 1) {
    if (trimLabel(items[i] && items[i].labelDef) === label) return i;
  }
  return -1;
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
  if (itemOp === 'istore' || itemOp === 'lstore' || itemOp === 'fstore' || itemOp === 'dstore') return String(arg(item));
  const match = /^(?:i|l|f|d)store_([0-3])$/.exec(itemOp || '');
  return match ? match[1] : null;
}

function iincLocal(item) {
  if (op(item) !== 'iinc') return null;
  const insn = item && item.instruction;
  if (insn && typeof insn.varnum !== 'undefined') return String(insn.varnum);
  const value = arg(item);
  if (value && typeof value === 'object' && typeof value.local !== 'undefined') return String(value.local);
  return typeof value === 'number' || typeof value === 'string' ? String(value).split(/\s+/)[0] : null;
}

function op(item) {
  const insn = item && item.instruction;
  return typeof insn === 'string' ? insn : insn && insn.op;
}

function arg(item) {
  const insn = item && item.instruction;
  return insn && typeof insn === 'object' ? insn.arg : null;
}

function trimLabel(label) {
  return typeof label === 'string' ? label.replace(/:$/, '') : null;
}

module.exports = {
  runMaterializeSkippedStringLocals,
  materializeCode,
};

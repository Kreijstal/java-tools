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
  const maxInsertions = options.maxInsertions || 64;
  for (let i = 0; i < items.length; i += 1) {
    const baseLocal = astoreLocal(items[i]);
    const baseDesc = baseLocal == null ? null : producedDescriptorForStore(items, i);
    if (baseLocal == null || !isReferenceDescriptor(baseDesc)) continue;
    const candidate = findSkippedReferenceCandidate(items, i + 1, baseLocal, baseDesc, i);
    if (!candidate) continue;
    insertions.push({ index: i + 1, baseLocal, stores: candidate.stores });
  }
  if (insertions.length === 0 || insertions.length > maxInsertions) return 0;
  for (const insertion of insertions.sort((a, b) => b.index - a.index)) {
    const added = [];
    let sourceLocal = insertion.baseLocal;
    for (const targetLocal of insertion.stores) {
      added.push({ instruction: loadRef(sourceLocal) }, { instruction: storeRef(targetLocal) });
      sourceLocal = targetLocal;
    }
    items.splice(insertion.index, 0, ...added);
  }
  return insertions.length;
}

function findSkippedReferenceCandidate(items, start, baseLocal, baseDesc, baseStoreIndex) {
  for (let i = start, seen = 0; i < items.length && seen < 160; i += 1, seen += 1) {
    const itemOp = op(items[i]);
    if (!itemOp) continue;
    if (astoreLocal(items[i]) === baseLocal) return null;
    if (!itemOp.startsWith('if')) continue;
    const target = trimLabel(arg(items[i]));
    if (!target) continue;
    const targetIndex = findLabel(items, target);
    if (targetIndex < 0 || targetIndex <= i) continue;
    const candidate = baseDesc === 'Ljava/lang/String;'
      ? findReferenceStoreBefore(items, i + 1, targetIndex, baseDesc)
      : null;
    if (candidate && candidate.local !== baseLocal) {
      const joinIndex = findForwardGotoTarget(items, candidate.index + 1, targetIndex) || targetIndex;
      const stores = [{ index: candidate.index, local: candidate.local }];
      stores.push(...findAliasCopiesBefore(items, candidate.index + 1, joinIndex, candidate.local));
      const usefulStores = stores.filter((store) => isTypedLocalUsedAfter(items, joinIndex, store.local, baseDesc));
      if (usefulStores.length > 0) return { stores: stores.map((store) => store.local) };
    }

    const allowTargetBranch = baseDesc === 'Ljava/lang/String;' ||
      (isConcreteObjectDescriptor(baseDesc) && storeProducedByArrayLoad(items, baseStoreIndex));
    if (!allowTargetBranch) continue;
    const targetCandidate = findReferenceStoreBefore(items, targetIndex, Math.min(items.length, targetIndex + 200), baseDesc);
    if (!targetCandidate || targetCandidate.local === baseLocal) continue;
    if (producedDescriptorForStore(items, targetCandidate.index) !== baseDesc) continue;
    const stores = [{ index: targetCandidate.index, local: targetCandidate.local }];
    stores.push(...findAliasCopiesBefore(items, targetCandidate.index + 1, Math.min(items.length, targetCandidate.index + 128), targetCandidate.local));
    if (baseDesc === 'Ljava/lang/String;' &&
        !stores.some((store) => isStringIntStaticUseAfter(items, store.index + 1, store.local))) continue;
    const usefulStores = stores.filter((store) => isTypedLocalUsedAfter(items, store.index + 1, store.local, baseDesc));
    if (usefulStores.length > 0) return { stores: stores.map((store) => store.local) };
  }
  return null;
}

function findForwardGotoTarget(items, start, end) {
  for (let i = start; i < end; i += 1) {
    if (op(items[i]) !== 'goto') continue;
    const target = trimLabel(arg(items[i]));
    const targetIndex = target ? findLabel(items, target) : -1;
    if (targetIndex > end) return targetIndex;
  }
  return null;
}

function findReferenceStoreBefore(items, start, end, baseDesc) {
  let found = null;
  for (let i = start; i < end; i += 1) {
    const local = astoreLocal(items[i]);
    if (local == null) continue;
    const desc = producedDescriptorForStore(items, i);
    if (!storeDescriptorsCompatible(baseDesc, desc)) continue;
    if (!found) found = { index: i, local };
  }
  return found;
}

function findAliasCopiesBefore(items, start, end, sourceLocal) {
  const aliases = [];
  let current = sourceLocal;
  for (let i = start; i < end; i += 1) {
    const local = astoreLocal(items[i]);
    if (local == null) continue;
    const prev = previousInstructionIndex(items, i);
    if (prev < 0 || aloadLocal(items[prev]) !== current) continue;
    aliases.push({ index: i, local });
    current = local;
  }
  return aliases;
}

function isTypedLocalUsedAfter(items, start, local, desc) {
  for (let i = start; i < items.length; i += 1) {
    if (astoreLocal(items[i]) === local) return false;
    if (primitiveStoreLocal(items[i]) === local || iincLocal(items[i]) === local) return false;
    if (aloadLocal(items[i]) !== local) continue;
    if (isTypedUse(items, i, desc)) return true;
  }
  return false;
}

function isTypedUse(items, loadIndex, desc) {
  for (let i = nextInstructionIndex(items, loadIndex), seen = 0;
    i >= 0 && seen < 8;
    i = nextInstructionIndex(items, i), seen += 1) {
    const itemOp = op(items[i]);
    if (itemOp === 'getfield') {
      const ref = arg(items[i]);
      const owner = Array.isArray(ref) && typeof ref[1] === 'string' ? `L${ref[1]};` : null;
      return typesCompatible(desc, owner);
    }
    if (/^invoke/.test(itemOp || '')) {
      return invokeConsumesDescriptor(items, loadIndex, i, desc);
    }
    if (!isSimpleStackProducer(items[i])) return false;
  }
  return false;
}

function isStringIntStaticUseAfter(items, start, local) {
  for (let i = start; i < items.length; i += 1) {
    if (astoreLocal(items[i]) === local || primitiveStoreLocal(items[i]) === local || iincLocal(items[i]) === local) return false;
    if (aloadLocal(items[i]) !== local) continue;
    for (let j = nextInstructionIndex(items, i), seen = 0; j >= 0 && seen < 4; j = nextInstructionIndex(items, j), seen += 1) {
      const itemOp = op(items[j]);
      if (itemOp === 'invokestatic') {
        const ref = arg(items[j]);
        const desc = Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
        return desc === '(Ljava/lang/String;I)V';
      }
      if (!isSimpleStackProducer(items[j])) return false;
    }
    return false;
  }
  return false;
}

function invokeConsumesDescriptor(items, loadIndex, invokeIndex, desc) {
  const ref = arg(items[invokeIndex]);
  const methodDesc = Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
  const args = argumentDescriptors(methodDesc);
  if (!args) return false;
  const owner = Array.isArray(ref) && typeof ref[1] === 'string' ? `L${ref[1]};` : null;
  const hasReceiver = !/^invokestatic/.test(op(items[invokeIndex]) || '');
  const marker = { marker: true };
  const stack = [marker];
  for (let i = nextInstructionIndex(items, loadIndex); i >= 0 && i < invokeIndex; i = nextInstructionIndex(items, i)) {
    if (!simulateStackEffect(items[i], stack)) return false;
  }
  for (let argIndex = args.length - 1, stackIndex = stack.length - 1; argIndex >= 0 && stackIndex >= 0; argIndex -= 1, stackIndex -= 1) {
    if (stack[stackIndex] === marker) return typesCompatible(desc, args[argIndex]);
  }
  const receiverIndex = stack.length - args.length - 1;
  return hasReceiver && receiverIndex >= 0 && stack[receiverIndex] === marker && typesCompatible(desc, owner);
}

function producedDescriptorForStore(items, storeIndex) {
  const prev = previousInstructionIndex(items, storeIndex);
  if (prev < 0) return null;
  const itemOp = op(items[prev]);
  if (itemOp === 'ldc' || itemOp === 'ldc_w') return typeof arg(items[prev]) === 'string' ? 'Ljava/lang/String;' : null;
  if (itemOp === 'checkcast') return referenceDescriptorFromClassName(arg(items[prev]));
  if (itemOp === 'getfield' || itemOp === 'getstatic') {
    const ref = arg(items[prev]);
    return Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
  }
  if (itemOp === 'aaload') return arrayElementDescriptor(producedDescriptorForInstruction(items, previousInstructionIndex(items, previousInstructionIndex(items, prev))));
  if (/^invoke/.test(itemOp || '')) {
    const ref = arg(items[prev]);
    const desc = Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
    return returnDescriptor(desc);
  }
  const sourceLocal = aloadLocal(items[prev]);
  if (sourceLocal == null) return null;
  for (let i = prev - 1; i >= 0; i -= 1) {
    if (astoreLocal(items[i]) === sourceLocal) return producedDescriptorForStore(items, i);
    if (primitiveStoreLocal(items[i]) === sourceLocal || iincLocal(items[i]) === sourceLocal) return null;
  }
  return null;
}

function storeProducedByArrayLoad(items, storeIndex) {
  const prev = previousInstructionIndex(items, storeIndex);
  return prev >= 0 && op(items[prev]) === 'aaload';
}

function producedDescriptorForInstruction(items, index) {
  if (index < 0) return null;
  const itemOp = op(items[index]);
  if (itemOp === 'checkcast') return referenceDescriptorFromClassName(arg(items[index]));
  if (itemOp === 'getfield' || itemOp === 'getstatic') {
    const ref = arg(items[index]);
    return Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
  }
  if (/^invoke/.test(itemOp || '')) {
    const ref = arg(items[index]);
    const desc = Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
    return returnDescriptor(desc);
  }
  const local = aloadLocal(items[index]);
  if (local == null) return null;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (astoreLocal(items[i]) === local) return producedDescriptorForStore(items, i);
    if (primitiveStoreLocal(items[i]) === local || iincLocal(items[i]) === local) return null;
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

function isReferenceDescriptor(desc) {
  return typeof desc === 'string' && (desc.startsWith('L') || desc.startsWith('['));
}

function isConcreteObjectDescriptor(desc) {
  return typeof desc === 'string' &&
    /^L[^;]+;$/.test(desc) &&
    desc !== 'Ljava/lang/Object;' &&
    desc !== 'Ljava/lang/String;';
}

function typesCompatible(expected, actual) {
  if (!expected || !actual) return false;
  if (expected === actual) return true;
  if (expected === 'Ljava/lang/Object;' && isReferenceDescriptor(actual)) return true;
  if (actual === 'Ljava/lang/Object;' && isReferenceDescriptor(expected)) return true;
  return false;
}

function storeDescriptorsCompatible(expected, actual) {
  return expected === actual && isReferenceDescriptor(expected);
}

function arrayElementDescriptor(desc) {
  return typeof desc === 'string' && desc.startsWith('[') ? desc.slice(1) : null;
}

function argumentDescriptors(desc) {
  if (typeof desc !== 'string' || desc[0] !== '(') return null;
  const out = [];
  for (let i = 1; i < desc.length && desc[i] !== ')';) {
    const start = i;
    while (desc[i] === '[') i += 1;
    if (desc[i] === 'L') {
      const end = desc.indexOf(';', i);
      if (end < 0) return null;
      out.push(desc.slice(start, end + 1));
      i = end + 1;
    } else {
      if (!desc[i]) return null;
      out.push(desc.slice(start, i + 1));
      i += 1;
    }
  }
  return out;
}

function simulateStackEffect(item, stack) {
  const itemOp = op(item);
  const push = () => {
    stack.push('?');
    return true;
  };
  const pop = (count) => {
    for (let i = 0; i < count; i += 1) {
      if (!stack.length) return false;
      stack.pop();
    }
    return true;
  };
  if (aloadLocal(item) != null || /^(?:i|l|f|d)load(?:_[0-3])?$/.test(itemOp || '')) return push();
  if (/^(?:aconst_null|iconst_m1|iconst_[0-5]|lconst_[0-1]|fconst_[0-2]|dconst_[0-1])$/.test(itemOp || '')) return push();
  if (itemOp === 'bipush' || itemOp === 'sipush' || itemOp === 'ldc' || itemOp === 'ldc_w' || itemOp === 'ldc2_w') return push();
  if (itemOp === 'getstatic') return push();
  if (itemOp === 'getfield') return pop(1) && push();
  if (itemOp === 'aaload' || /^[bcdfils]aload$/.test(itemOp || '')) return pop(2) && push();
  if (/^[bcdfilsa]store$/.test(itemOp || '')) return pop(itemOp === 'lastore' || itemOp === 'dastore' ? 4 : 3);
  if (/^(?:i|f|l|d)(?:add|sub|mul|div|rem|and|or|xor|shl|shr|ushr)$/.test(itemOp || '')) return pop(2) && push();
  if (/^(?:i2[bcdfsl]|f2[dil]|d2[fil]|l2[dfi])$/.test(itemOp || '')) return pop(1) && push();
  if (itemOp === 'checkcast') return true;
  if (itemOp === 'dup') {
    if (!stack.length) return false;
    stack.push(stack[stack.length - 1]);
    return true;
  }
  return false;
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

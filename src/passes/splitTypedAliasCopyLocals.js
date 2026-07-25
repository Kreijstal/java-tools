'use strict';

function runSplitTypedAliasCopyLocals(astRoot, options = {}) {
  let rewrites = 0;
  for (const cls of astRoot.classes || []) {
    for (const item of cls.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      for (const attr of item.method.attributes || []) {
        const code = attr && attr.type === 'code' && attr.code;
        if (!code || !Array.isArray(code.codeItems)) continue;
        rewrites += splitCode(code, options);
      }
    }
  }
  return { changed: rewrites > 0, rewrites };
}

function splitCode(code, options = {}) {
  const items = code.codeItems;
  if (items.length > (options.maxMethodItems || 10000)) return 0;
  const refs = labelReferencesWithSources(code);
  const candidates = collectCandidates(code, refs, options);
  const maxCandidates = options.maxCandidates || 16;
  if (candidates.length === 0 || candidates.length > maxCandidates) return 0;

  let rewrites = 0;
  for (const candidate of candidates) {
    const fresh = allocateLocal(code);
    candidate.sourceStore.instruction = storeRef(fresh);
    if (candidate.aliasStore) candidate.aliasStore.instruction = storeRef(fresh);
    for (const load of candidate.loads) {
      load.instruction = loadRef(fresh);
    }
    rewrites += 1;
  }
  return rewrites;
}

function collectCandidates(code, refs, options) {
  const items = code.codeItems;
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    const sourceLocal = astoreLocal(items[i]);
    if (sourceLocal == null || isHandlerStore(code.exceptionTable, items[i])) continue;
    const desc = producedDescriptorForStore(items, i);
    if (!isConcreteReferenceDescriptor(desc)) continue;

    const loadIndex = nextInstructionIndex(items, i);
    const aliasIndex = loadIndex >= 0 ? nextInstructionIndex(items, loadIndex) : -1;
    if (loadIndex < 0 || aliasIndex < 0) continue;
    if (aloadLocal(items[loadIndex]) !== sourceLocal) continue;
    const aliasLocal = astoreLocal(items[aliasIndex]);
    if (aliasLocal == null || aliasLocal === sourceLocal) continue;
    if (isHandlerStore(code.exceptionTable, items[aliasIndex])) continue;

    const sourceEnd = nextLocalWriteIndex(items, i + 1, sourceLocal);
    const aliasEnd = nextLocalWriteIndex(items, aliasIndex + 1, aliasLocal);
    const sourcePolluted = hasAnyLaterPollutingWrite(items, i + 1, sourceLocal, desc);
    const aliasPolluted = hasAnyLaterPollutingWrite(items, aliasIndex + 1, aliasLocal, desc);
    if (!sourcePolluted && !aliasPolluted) continue;

    const sourceLimit = sourceEnd < 0 ? items.length : sourceEnd;
    const aliasLimit = aliasEnd < 0 ? items.length : aliasEnd;
    const sourceLoads = collectLoads(items, sourceLocal, i + 1, sourceLimit);
    const lastSourceLoad = lastItemIndex(items, sourceLoads);
    if (lastSourceLoad < 0 || hasIncomingBranchFromOutside(items, refs, i, lastSourceLoad + 1)) continue;

    let aliasStore = null;
    let aliasLoads = [];
    if (aliasPolluted) {
      aliasStore = items[aliasIndex];
      aliasLoads = collectLoads(items, aliasLocal, aliasIndex + 1, aliasLimit);
      const lastAliasLoad = lastItemIndex(items, aliasLoads);
      if (lastAliasLoad >= 0 && hasIncomingBranchFromOutside(items, refs, aliasIndex, lastAliasLoad + 1)) continue;
    }

    const loads = sourceLoads.concat(aliasLoads);
    if (!loads.includes(items[loadIndex])) continue;
    if (!allLoadsSimpleEnough(items, loads, desc, options)) continue;

    out.push({
      sourceStore: items[i],
      aliasStore,
      loads: uniqueItems(loads),
    });
  }
  return out;
}

function producedDescriptorForStore(items, storeIndex) {
  const prev = previousInstructionIndex(items, storeIndex);
  if (prev < 0) return null;
  const itemOp = op(items[prev]);
  if (itemOp === 'checkcast') return referenceDescriptorFromClassName(arg(items[prev]));
  if (itemOp === 'getfield' || itemOp === 'getstatic') {
    const ref = arg(items[prev]);
    return Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
  }
  if (itemOp === 'anewarray') return arrayDescriptorFromAnewarray(arg(items[prev]));
  if (itemOp === 'multianewarray') {
    const value = arg(items[prev]);
    return Array.isArray(value) ? value[0] : value;
  }
  if (/^invoke/.test(itemOp || '')) {
    const ref = arg(items[prev]);
    if (Array.isArray(ref) && Array.isArray(ref[2]) && ref[2][0] === '<init>' && typeof ref[1] === 'string') {
      return `L${ref[1]};`;
    }
    const desc = Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
    return returnDescriptor(desc);
  }
  return null;
}

function hasPollutingWrite(items, writeIndex, local, originalDesc) {
  if (writeIndex < 0) return false;
  if (primitiveStoreLocal(items[writeIndex]) === local || iincLocal(items[writeIndex]) === local) return true;
  if (astoreLocal(items[writeIndex]) !== local) return false;
  const desc = producedDescriptorForStore(items, writeIndex);
  return !descriptorsCompatible(originalDesc, desc);
}

function hasAnyLaterPollutingWrite(items, start, local, originalDesc) {
  for (let i = start; i < items.length; i += 1) {
    if (hasPollutingWrite(items, i, local, originalDesc)) return true;
  }
  return false;
}

function descriptorsCompatible(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (b === 'Ljava/lang/Object;' || b === '[Ljava/lang/Object;') return true;
  return false;
}

function collectLoads(items, local, start, end) {
  const out = [];
  for (let i = start; i < end; i += 1) {
    if (aloadLocal(items[i]) === local) out.push(items[i]);
  }
  return out;
}

function allLoadsSimpleEnough(items, loads, desc, options) {
  if (options.rewriteAllLoads) return true;
  for (const load of loads) {
    const loadIndex = items.indexOf(load);
    const useIndex = nextInstructionIndex(items, loadIndex);
    if (useIndex < 0) return false;
    if (isNullCompare(items[useIndex])) continue;
    if (isMatchingFieldRead(items[useIndex], desc)) continue;
    if (isMatchingFieldReceiverWrite(items, loadIndex, desc)) continue;
    if (methodArgumentDescriptorAtUse(items, loadIndex)) continue;
    if (astoreLocal(items[useIndex]) != null) continue;
    return false;
  }
  return true;
}

function methodArgumentDescriptorAtUse(items, loadIndex) {
  const marker = Symbol('tracked-local');
  const suffixStack = [marker];
  for (let i = nextInstructionIndex(items, loadIndex), seen = 0;
    i >= 0 && seen < 8;
    i = nextInstructionIndex(items, i), seen += 1) {
    const itemOp = op(items[i]);
    if (/^invoke/.test(itemOp || '')) {
      return true;
    }
    if (!applySimpleStackEffect(suffixStack, items[i])) return false;
  }
  return false;
}

function applySimpleStackEffect(stack, item) {
  const itemOp = op(item);
  if (/^(?:a|i|l|f|d)load(?:_[0-3])?$/.test(itemOp || '') ||
      /^(?:aconst_null|iconst_m1|iconst_[0-5]|lconst_[0-1]|fconst_[0-2]|dconst_[0-1])$/.test(itemOp || '') ||
      itemOp === 'bipush' || itemOp === 'sipush' || itemOp === 'ldc' ||
      itemOp === 'getstatic' || itemOp === 'new') {
    stack.push(Symbol('value'));
    return true;
  }
  if (itemOp === 'getfield') {
    if (stack.length > 0) stack.pop();
    stack.push(Symbol('value'));
    return true;
  }
  if (itemOp === 'checkcast') return true;
  if (/^(?:i|l|f|d|a)aload$/.test(itemOp || '')) {
    if (stack.length > 0) stack.pop();
    if (stack.length > 0) stack.pop();
    stack.push(Symbol('value'));
    return true;
  }
  return false;
}

function isMatchingFieldRead(item, desc) {
  if (op(item) !== 'getfield') return false;
  const ref = arg(item);
  return Array.isArray(ref) && descriptorOwner(desc) === ref[1];
}

function isMatchingFieldReceiverWrite(items, loadIndex, desc) {
  for (let i = nextInstructionIndex(items, loadIndex), seen = 0;
    i >= 0 && seen < 7;
    i = nextInstructionIndex(items, i), seen += 1) {
    if (op(items[i]) === 'putfield') {
      const ref = arg(items[i]);
      return Array.isArray(ref) && descriptorOwner(desc) === ref[1];
    }
    if (!isSimpleFieldValueProducer(items[i])) return false;
  }
  return false;
}

function isSimpleFieldValueProducer(item) {
  const itemOp = op(item);
  return /^(?:a|i|l|f|d)load(?:_[0-3])?$/.test(itemOp || '') ||
    /^(?:aconst_null|iconst_m1|iconst_[0-5]|lconst_[0-1]|fconst_[0-2]|dconst_[0-1])$/.test(itemOp || '') ||
    itemOp === 'bipush' || itemOp === 'sipush' || itemOp === 'ldc' ||
    itemOp === 'getstatic' || itemOp === 'getfield' || itemOp === 'dup' ||
    itemOp === 'iadd' || itemOp === 'isub' || itemOp === 'imul' || itemOp === 'idiv' ||
    itemOp === 'ineg';
}

function isNullCompare(item) {
  const itemOp = op(item);
  return itemOp === 'ifnull' || itemOp === 'ifnonnull' ||
    itemOp === 'if_acmpeq' || itemOp === 'if_acmpne';
}

function isConcreteReferenceDescriptor(desc) {
  return typeof desc === 'string' && /^(?:L|\[L)[^;]+;$/.test(desc) &&
    desc !== 'Ljava/lang/Object;' && desc !== 'Ljava/lang/Throwable;' &&
    desc !== 'Ljava/lang/Exception;' && desc !== '[Ljava/lang/Object;';
}

function referenceDescriptorFromClassName(value) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('[')) return value;
  if (value === 'java/lang/Object' || value === 'java/lang/Throwable' || value === 'java/lang/Exception') return null;
  return `L${value};`;
}

function arrayDescriptorFromAnewarray(value) {
  if (typeof value !== 'string') return null;
  return value.startsWith('[') ? `[${value}` : `[L${value};`;
}

function returnDescriptor(desc) {
  if (typeof desc !== 'string') return null;
  const idx = desc.lastIndexOf(')');
  return idx >= 0 ? desc.slice(idx + 1) : null;
}

function descriptorOwner(desc) {
  return typeof desc === 'string' && /^L[^;]+;$/.test(desc) ? desc.slice(1, -1) : null;
}

function labelReferencesWithSources(code) {
  const refs = new Map();
  const items = code.codeItems || [];
  for (let i = 0; i < items.length; i += 1) {
    for (const label of branchTargets(items[i])) {
      const key = trimLabel(label);
      if (!key) continue;
      if (!refs.has(key)) refs.set(key, []);
      refs.get(key).push(i);
    }
  }
  for (const entry of code.exceptionTable || []) {
    for (const label of [entry.startLbl, entry.endLbl, entry.handlerLbl]) {
      const key = trimLabel(label);
      if (!key) continue;
      if (!refs.has(key)) refs.set(key, []);
      refs.get(key).push(-1);
    }
  }
  return refs;
}

function hasIncomingBranchFromOutside(items, refs, start, end) {
  for (let i = start; i < end; i += 1) {
    const label = trimLabel(items[i] && items[i].labelDef);
    if (!label) continue;
    for (const source of refs.get(label) || []) {
      if (source < start || source >= end) return true;
    }
  }
  return false;
}

function branchTargets(item) {
  const insn = item && item.instruction;
  if (!insn || typeof insn !== 'object') return [];
  if (!insn.op || (!insn.op.startsWith('if') && insn.op !== 'goto' && insn.op !== 'jsr')) return [];
  return typeof insn.arg === 'string' ? [insn.arg] : [];
}

function isHandlerStore(exceptionTable, item) {
  const label = trimLabel(item && item.labelDef);
  return !!label && (exceptionTable || []).some((entry) => trimLabel(entry.handlerLbl) === label);
}

function nextLocalWriteIndex(items, start, local) {
  for (let i = start; i < items.length; i += 1) {
    if (astoreLocal(items[i]) === local ||
        primitiveStoreLocal(items[i]) === local ||
        iincLocal(items[i]) === local) {
      return i;
    }
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

function allocateLocal(code) {
  const current = Number(code.locals || code.localsSize || 0);
  const next = String(current + 1);
  if ('locals' in code) code.locals = next;
  else code.localsSize = next;
  return String(current);
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
  if (/^aload_[0-3]$/.test(itemOp || '')) return itemOp.slice(-1);
  return null;
}

function astoreLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'astore') return String(arg(item));
  if (/^astore_[0-3]$/.test(itemOp || '')) return itemOp.slice(-1);
  return null;
}

function primitiveStoreLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'istore' || itemOp === 'lstore' || itemOp === 'fstore' || itemOp === 'dstore') return String(arg(item));
  const match = /^(?:i|l|f|d)store_([0-3])$/.exec(itemOp || '');
  return match ? match[1] : null;
}

function iincLocal(item) {
  if (op(item) !== 'iinc') return null;
  const value = arg(item);
  if (Array.isArray(value)) return String(value[0]);
  if (value && typeof value === 'object' && value.local != null) return String(value.local);
  if (typeof value === 'string') return value.split(/\s+/)[0];
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

function trimLabel(label) {
  return typeof label === 'string' ? label.replace(/:$/, '') : null;
}

function uniqueItems(items) {
  return [...new Set(items)];
}

function lastItemIndex(items, selected) {
  let last = -1;
  for (const item of selected || []) last = Math.max(last, items.indexOf(item));
  return last;
}

module.exports = {
  runSplitTypedAliasCopyLocals,
  splitCode,
};

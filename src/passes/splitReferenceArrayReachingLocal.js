'use strict';

const { buildCfg, reachingDefinitions } = require('./splitArrayReachingLocal');

const ARRAY_OPS = new Set(['aaload', 'aastore', 'arraylength']);

function runSplitReferenceArrayReachingLocal(astRoot) {
  let rewrites = 0;
  for (const cls of astRoot.classes || []) {
    for (const item of cls.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      for (const attr of item.method.attributes || []) {
        const code = attr && attr.type === 'code' && attr.code;
        if (!code || !Array.isArray(code.codeItems)) continue;
        rewrites += splitCode(code);
      }
    }
  }
  return { changed: rewrites > 0, rewrites };
}

function splitCode(code) {
  const items = code.codeItems;
  if (items.length > 2000) return 0;
  const cfg = buildCfg(code);
  if (!cfg.blocks.length) return 0;
  const analysis = reachingDefinitions(code, cfg);
  let rewrites = rewriteConcreteArrayAliasCopies(code, analysis);
  const candidates = mergeCandidates(
    collectCandidates(code, analysis),
    collectLinearPrimitiveReuseCandidates(code),
    collectConcreteArrayViewCandidates(code, analysis),
  );
  if (candidates.length > 8) return 0;

  for (const candidate of candidates) {
    const widened = widenedArrayDescriptorForCopiedUse(items, candidate);
    if (widened) {
      widenArrayProducer(items, candidate.storeIndex, widened);
      candidate.desc = widened;
    }
    candidate.fresh = allocateLocal(code);
    for (const item of candidate.loadItems) item.instruction = loadRef(candidate.fresh);
  }

  const castInsertions = [];
  for (const candidate of candidates) {
    const element = elementClassName(candidate.desc);
    if (!element) continue;
    for (const item of candidate.loadItems) {
      const loadIndex = items.indexOf(item);
      const storeIndex = findAastoreUse(items, loadIndex);
      if (storeIndex >= 0) castInsertions.push({ index: storeIndex, element });
    }
  }
  for (const insertion of castInsertions.sort((a, b) => b.index - a.index)) {
    if (op(items[insertion.index - 1]) === 'checkcast') continue;
    items.splice(insertion.index, 0, { instruction: { op: 'checkcast', arg: insertion.element } });
  }

  for (const candidate of candidates.sort((a, b) => b.storeIndex - a.storeIndex)) {
    const idx = items.indexOf(candidate.storeItem);
    if (idx < 0) continue;
    candidate.storeItem.instruction = storeRef(candidate.fresh);
    rewrites += 1;
  }
  return rewrites;
}

function rewriteConcreteArrayAliasCopies(code, analysis) {
  const items = code.codeItems;
  let rewrites = 0;
  for (let i = 0; i < items.length; i += 1) {
    const aliasLocal = aloadLocal(items[i]);
    if (aliasLocal == null) continue;
    const useIndex = nextInstructionIndex(items, i);
    const copiedLocal = useIndex >= 0 ? astoreLocal(items[useIndex]) : null;
    if (copiedLocal == null) continue;
    const aliasDef = singleReachingDef(analysis, i, aliasLocal);
    if (!aliasDef) continue;
    const sourceIndex = previousInstructionIndex(items, aliasDef.index);
    if (sourceIndex < 0) continue;
    const sourceLocal = aloadLocal(items[sourceIndex]);
    if (sourceLocal == null || sourceLocal === aliasLocal) continue;
    const sourceDefAtAlias = singleReachingDef(analysis, sourceIndex, sourceLocal);
    const sourceDefAtUse = singleReachingDef(analysis, i, sourceLocal);
    if (!sourceDefAtAlias || !sourceDefAtUse || sourceDefAtAlias.id !== sourceDefAtUse.id) continue;
    const sourceDesc = referenceArrayProducerDescriptor(items, sourceDefAtAlias.index, analysis);
    if (!isConcreteReferenceArrayDescriptor(sourceDesc)) continue;
    const copiedUseDesc = firstConcreteArrayUseDescriptor(items, useIndex + 1, copiedLocal);
    if (copiedUseDesc !== sourceDesc && !hasOnlyArrayOperationsUntilWrite(items, useIndex + 1, copiedLocal)) continue;
    items[i].instruction = loadRef(sourceLocal);
    rewrites += 1;
  }
  return rewrites;
}

function hasOnlyArrayOperationsUntilWrite(items, start, local) {
  let arrayUses = 0;
  for (let i = start; i < items.length; i += 1) {
    if (astoreLocal(items[i]) === local || primitiveStoreLocal(items[i]) === local || iincLocal(items[i]) === local) return arrayUses > 0;
    if (aloadLocal(items[i]) !== local) continue;
    if (!hasArrayOperationWithin(items, i)) return false;
    arrayUses += 1;
  }
  return arrayUses > 0;
}

function hasArrayOperationWithin(items, loadIndex) {
  for (let i = nextInstructionIndex(items, loadIndex), seen = 0;
    i >= 0 && seen < 5;
    i = nextInstructionIndex(items, i), seen += 1) {
    if (ARRAY_OPS.has(op(items[i]))) return true;
    if (!isSimpleStackProducer(items[i])) return false;
  }
  return false;
}

function singleReachingDef(analysis, index, local) {
  const reaching = analysis.before[index] && analysis.before[index].get(local);
  if (!reaching || reaching.size !== 1) return null;
  const [defId] = reaching;
  if (typeof defId !== 'number') return null;
  return analysis.defs.get(defId) || null;
}

function mergeCandidates(...groups) {
  const byKey = new Map();
  for (const group of groups) {
    for (const candidate of group) {
      const key = `${candidate.storeIndex}:${candidate.local}`;
      let existing = byKey.get(key);
      if (!existing) {
        existing = { ...candidate, loadItems: [] };
        byKey.set(key, existing);
      }
      for (const item of candidate.loadItems || []) {
        if (!existing.loadItems.includes(item)) existing.loadItems.push(item);
      }
    }
  }
  return [...byKey.values()].filter((candidate) => candidate.loadItems.length > 0);
}

function collectCandidates(code, analysis) {
  const byStore = new Map();
  const items = code.codeItems;
  for (let i = 0; i < items.length; i += 1) {
    const local = aloadLocal(items[i]);
    if (local == null) continue;
    const reaching = analysis.before[i] && analysis.before[i].get(local);
    if (!reaching || reaching.size !== 1) continue;
    const [defId] = reaching;
    if (typeof defId !== 'number') continue;
    const def = analysis.defs.get(defId);
    if (!def || def.local !== local) continue;
    if (isHandlerStore(code.exceptionTable, items[def.index])) continue;
    if (!hasConflictingReferenceStore(items, def.index, local)) continue;
    if (!hasOtherPrimitiveArrayStore(items, def.index, local)) continue;
    if (hasPrimitiveLocalWrite(items, local)) continue;
    const desc = referenceArrayProducerDescriptor(items, def.index, analysis);
    if (!desc) continue;
    const key = String(defId);
    let candidate = byStore.get(key);
    if (!candidate) {
      candidate = { storeIndex: def.index, storeItem: items[def.index], local, desc, loadItems: [] };
      byStore.set(key, candidate);
    }
    candidate.loadItems.push(items[i]);
  }
  return [...byStore.values()].filter((candidate) =>
    candidate.loadItems.length > 0 && hasOnlyReferenceArrayUses(items, candidate));
}

function collectLinearPrimitiveReuseCandidates(code) {
  const out = [];
  const items = code.codeItems;
  for (let i = 0; i < items.length; i += 1) {
    const local = astoreLocal(items[i]);
    if (local == null || isHandlerStore(code.exceptionTable, items[i])) continue;
    const desc = referenceArrayProducerDescriptorNoAnalysis(items, i);
    if (!desc) continue;
    const nextStore = nextSameLocalStore(items, i, local);
    if (nextStore < 0 || !isPrimitiveArrayProducer(items, nextStore)) continue;
    const loadItems = [];
    let ok = true;
    for (let j = i + 1; j < nextStore; j += 1) {
      if (aloadLocal(items[j]) !== local) continue;
      const probe = { storeIndex: i, storeItem: items[i], local, desc, loadItems: [items[j]] };
      if (!hasOnlyReferenceArrayUses(items, probe)) {
        ok = false;
        break;
      }
      loadItems.push(items[j]);
    }
    if (ok && loadItems.length > 0) {
      out.push({ storeIndex: i, storeItem: items[i], local, desc, loadItems });
    }
  }
  return out;
}

function collectConcreteArrayViewCandidates(code, analysis) {
  const byStore = new Map();
  const items = code.codeItems;
  for (let i = 0; i < items.length; i += 1) {
    const local = aloadLocal(items[i]);
    if (local == null) continue;
    const expected = concreteArrayExpectedDescriptor(items, i);
    if (!expected) continue;
    const reaching = analysis.before[i] && analysis.before[i].get(local);
    if (!reaching || reaching.size !== 1) continue;
    const [defId] = reaching;
    if (typeof defId !== 'number') continue;
    const def = analysis.defs.get(defId);
    if (!def || def.local !== local) continue;
    if (isHandlerStore(code.exceptionTable, items[def.index])) continue;
    const produced = referenceArrayProducerDescriptor(items, def.index, analysis);
    if (produced !== expected) continue;
    if (!hasArrayViewStore(items, def.index, local, expected, analysis)) continue;
    const key = String(defId);
    let candidate = byStore.get(key);
    if (!candidate) {
      candidate = { storeIndex: def.index, storeItem: items[def.index], local, desc: expected, loadItems: [] };
      byStore.set(key, candidate);
    }
    candidate.loadItems.push(items[i]);
  }
  return [...byStore.values()].filter((candidate) =>
    candidate.loadItems.length > 0 && hasOnlyConcreteArrayViewUses(items, candidate));
}

function concreteArrayExpectedDescriptor(items, loadIndex) {
  const useIndex = nextInstructionIndex(items, loadIndex);
  if (useIndex < 0) return null;
  const copiedLocal = astoreLocal(items[useIndex]);
  if (copiedLocal == null) return null;
  return firstConcreteArrayUseDescriptor(items, useIndex + 1, copiedLocal);
}

function firstConcreteArrayUseDescriptor(items, start, local) {
  for (let i = start; i < items.length; i += 1) {
    if (astoreLocal(items[i]) === local) return null;
    if (aloadLocal(items[i]) !== local) continue;
    const desc = concreteCheckcastDescriptorAfterLoad(items, i) || typedConsumerDescriptorWithin(items, i);
    if (isConcreteReferenceArrayDescriptor(desc)) return desc;
  }
  return null;
}

function concreteCheckcastDescriptorAfterLoad(items, loadIndex) {
  const useIndex = nextInstructionIndex(items, loadIndex);
  if (useIndex < 0 || op(items[useIndex]) !== 'checkcast') return null;
  const desc = referenceDescriptorFromClassName(arg(items[useIndex]));
  return isConcreteReferenceArrayDescriptor(desc) ? desc : null;
}

function hasArrayViewStore(items, selfIndex, local, expected, analysis) {
  for (let i = 0; i < items.length; i += 1) {
    if (i === selfIndex || astoreLocal(items[i]) !== local) continue;
    const desc = referenceArrayProducerDescriptor(items, i, analysis);
    if (desc && desc !== expected) return true;
  }
  return false;
}

function hasOnlyConcreteArrayViewUses(items, candidate) {
  for (const loadItem of candidate.loadItems) {
    const loadIndex = items.indexOf(loadItem);
    const useIndex = nextInstructionIndex(items, loadIndex);
    if (useIndex < 0) return false;
    if (astoreLocal(items[useIndex]) == null) return false;
  }
  return true;
}

function widenedArrayDescriptorForCopiedUse(items, candidate) {
  for (const loadItem of candidate.loadItems) {
    const loadIndex = items.indexOf(loadItem);
    const useIndex = nextInstructionIndex(items, loadIndex);
    const copiedLocal = useIndex >= 0 ? astoreLocal(items[useIndex]) : null;
    if (copiedLocal == null) continue;
    const consumer = firstReferenceArrayConsumerDescriptor(items, useIndex + 1, copiedLocal);
    if (consumer && consumer !== candidate.desc && consumer !== '[Ljava/lang/Object;') return consumer;
  }
  return null;
}

function firstReferenceArrayConsumerDescriptor(items, start, local) {
  for (let i = start; i < items.length; i += 1) {
    if (astoreLocal(items[i]) === local) return null;
    if (aloadLocal(items[i]) !== local) continue;
    const desc = typedConsumerDescriptorWithin(items, i);
    if (isConcreteReferenceArrayDescriptor(desc)) return desc;
  }
  return null;
}

function typedConsumerDescriptorWithin(items, loadIndex) {
  for (let i = nextInstructionIndex(items, loadIndex), seen = 0;
    i >= 0 && seen < 8;
    i = nextInstructionIndex(items, i), seen += 1) {
    const itemOp = op(items[i]);
    if (/^invoke/.test(itemOp || '')) {
      const ref = arg(items[i]);
      const methodDesc = Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
      return firstReferenceArrayDescriptor(methodDesc);
    }
    if (itemOp === 'putfield' || itemOp === 'putstatic') {
      const ref = arg(items[i]);
      return Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
    }
    if (!isSimpleStackProducer(items[i])) return null;
  }
  return null;
}

function firstReferenceArrayDescriptor(methodDesc) {
  if (typeof methodDesc !== 'string') return null;
  const match = /\[L[^;]+;/.exec(methodDesc);
  return match ? match[0] : null;
}

function widenArrayProducer(items, storeIndex, desc) {
  const prev = previousInstructionIndex(items, storeIndex);
  if (prev < 0 || op(items[prev]) !== 'anewarray') return false;
  items[prev].instruction.arg = elementClassName(desc);
  return true;
}

function referenceArrayProducerDescriptorNoAnalysis(items, storeIndex) {
  const prev = previousInstructionIndex(items, storeIndex);
  if (prev < 0) return null;
  const desc = producerDescriptor(items[prev]);
  return isConcreteReferenceArrayDescriptor(desc) ? desc : null;
}

function nextSameLocalStore(items, index, local) {
  for (let i = index + 1; i < items.length; i += 1) {
    if (astoreLocal(items[i]) === local) return i;
  }
  return -1;
}

function referenceArrayProducerDescriptor(items, storeIndex, analysis, seen = new Set()) {
  if (seen.has(storeIndex)) return null;
  seen.add(storeIndex);
  const prev = previousInstructionIndex(items, storeIndex);
  if (prev < 0) return null;
  const desc = producerDescriptor(items[prev]);
  if (isConcreteReferenceArrayDescriptor(desc)) return desc;
  const sourceLocal = aloadLocal(items[prev]);
  if (sourceLocal == null || !analysis) return null;
  const reaching = analysis.before[prev] && analysis.before[prev].get(sourceLocal);
  if (!reaching || reaching.size !== 1) return null;
  const [defId] = reaching;
  if (typeof defId !== 'number') return null;
  const def = analysis.defs.get(defId);
  if (!def) return null;
  return referenceArrayProducerDescriptor(items, def.index, analysis, seen);
}

function producerDescriptor(item) {
  const insn = item && item.instruction;
  if (!insn || typeof insn !== 'object') return null;
  if (insn.op === 'anewarray') {
    return isConcreteClassName(insn.arg) ? `[L${insn.arg};` : null;
  }
  if (insn.op === 'checkcast') {
    return isConcreteReferenceArrayDescriptor(insn.arg) ? insn.arg : null;
  }
  if (insn.op === 'getstatic' || insn.op === 'getfield') {
    const ref = insn.arg;
    return Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
  }
  if (/^invoke/.test(insn.op || '')) {
    const ref = insn.arg;
    const desc = Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
    return typeof desc === 'string' ? desc.slice(desc.lastIndexOf(')') + 1) : null;
  }
  return null;
}

function referenceDescriptorFromClassName(value) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('[')) return value;
  return `[L${value};`;
}

function hasOnlyReferenceArrayUses(items, candidate) {
  for (const loadItem of candidate.loadItems) {
    const loadIndex = items.indexOf(loadItem);
    if (loadIndex < 0) return false;
    const useIndex = nextInstructionIndex(items, loadIndex);
    if (useIndex < 0) return false;
    if (ARRAY_OPS.has(op(items[useIndex]))) continue;
    if (isArrayStoreUse(items, loadIndex)) continue;
    if (astoreLocal(items[useIndex]) != null) continue;
    if (isTypedConsumerWithin(items, loadIndex, candidate.desc)) continue;
    return false;
  }
  return true;
}

function isArrayStoreUse(items, loadIndex) {
  return findAastoreUse(items, loadIndex) >= 0;
}

function findAastoreUse(items, loadIndex) {
  for (let i = nextInstructionIndex(items, loadIndex), seen = 0;
    i >= 0 && seen < 8;
    i = nextInstructionIndex(items, i), seen += 1) {
    const itemOp = op(items[i]);
    if (itemOp === 'aastore') return i;
    if (itemOp === 'arraylength') return -1;
    if (!isSimpleStackProducer(items[i])) return -1;
  }
  return -1;
}

function isTypedConsumerWithin(items, loadIndex, desc) {
  for (let i = nextInstructionIndex(items, loadIndex), seen = 0;
    i >= 0 && seen < 8;
    i = nextInstructionIndex(items, i), seen += 1) {
    const itemOp = op(items[i]);
    if (itemOp === 'putfield' || itemOp === 'putstatic') {
      const ref = arg(items[i]);
      return Array.isArray(ref) && Array.isArray(ref[2]) && ref[2][1] === desc;
    }
    if (/^invoke/.test(itemOp || '')) {
      const ref = arg(items[i]);
      const methodDesc = Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
      return typeof methodDesc === 'string' &&
        (methodDesc.includes(desc) || methodDesc.includes('[Ljava/lang/Object;'));
    }
    if (!isSimpleStackProducer(items[i])) return false;
  }
  return false;
}

function isSimpleStackProducer(item) {
  const itemOp = op(item);
  return /^(?:a|i|l|f|d)load(?:_[0-3])?$/.test(itemOp || '') ||
    /^(?:iconst_m1|iconst_[0-5]|aconst_null)$/.test(itemOp || '') ||
    itemOp === 'bipush' || itemOp === 'sipush' || itemOp === 'ldc' ||
    itemOp === 'getstatic' || itemOp === 'getfield' || itemOp === 'aaload' ||
    itemOp === 'iadd' || itemOp === 'isub';
}

function isConcreteReferenceArrayDescriptor(desc) {
  return typeof desc === 'string' && /^\[L[^;]+;$/.test(desc) && desc !== '[Ljava/lang/Object;';
}

function elementClassName(desc) {
  return isConcreteReferenceArrayDescriptor(desc) ? desc.slice(2, -1) : null;
}

function isConcreteClassName(target) {
  return typeof target === 'string' && target !== 'java/lang/Object' && !target.startsWith('[');
}

function hasConflictingReferenceStore(items, selfIndex, local) {
  for (let i = 0; i < items.length; i += 1) {
    if (i === selfIndex) continue;
    if (astoreLocal(items[i]) === local) return true;
  }
  return false;
}

function hasOtherPrimitiveArrayStore(items, selfIndex, local) {
  for (let i = 0; i < items.length; i += 1) {
    if (i === selfIndex || astoreLocal(items[i]) !== local) continue;
    if (isPrimitiveArrayProducer(items, i)) return true;
  }
  return false;
}

function isPrimitiveArrayProducer(items, storeIndex) {
  const prev = previousInstructionIndex(items, storeIndex);
  if (prev < 0) return false;
  if (op(items[prev]) === 'newarray') return isPrimitiveArrayElement(arg(items[prev]));
  const desc = producerDescriptor(items[prev]);
  return typeof desc === 'string' && /^\[+[ZBCSIJFD]$/.test(desc);
}

function isPrimitiveArrayElement(value) {
  return value === 'boolean' || value === 'byte' || value === 'char' || value === 'short' ||
    value === 'int' || value === 'long' || value === 'float' || value === 'double';
}

function hasPrimitiveLocalWrite(items, local) {
  for (const item of items) {
    if (primitiveStoreLocal(item) === String(local)) return true;
    if (iincLocal(item) === String(local)) return true;
  }
  return false;
}

function primitiveStoreLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'istore' || itemOp === 'lstore' || itemOp === 'fstore' || itemOp === 'dstore') {
    return String(arg(item));
  }
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

function isHandlerStore(exceptionTable, item) {
  const label = trimLabel(item && item.labelDef);
  return !!label && (exceptionTable || []).some((entry) => trimLabel(entry.handlerLbl) === label);
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
  runSplitReferenceArrayReachingLocal,
  splitCode,
};

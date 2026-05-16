'use strict';

const {
  buildCfg,
  computeDominators,
  instructionDominates,
  reachingDefinitions,
} = require('./splitArrayReachingLocal');

function runSplitConcreteObjectReachingLocal(astRoot, options = {}) {
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
  if (items.length > 10000) return 0;
  const cfg = buildCfg(code);
  if (!cfg.blocks.length) return 0;
  const analysis = reachingDefinitions(code, cfg);
  const requireDominance = !!options.requireDominance;
  const preserveOriginalLocals = !!options.preserveOriginalLocals;
  const dominators = requireDominance ? computeDominators(cfg) : null;
  let candidates = mergeCandidates(
    collectCandidates(code, cfg, analysis, dominators),
    collectLinearExplicitCastRanges(code),
    collectSingleCastedRangesBeforeReferenceReuse(code, analysis),
    collectCastedLoopRanges(code),
    collectCastedCursorRanges(code, cfg, analysis, dominators),
  );
  if (candidates.length > 8) {
    candidates = candidates.filter((candidate) =>
      candidate.explicitCast && !candidate.primitiveLocalWrite && !candidate.desc.startsWith('[L'));
  }
  if (candidates.length > 8) return 0;

  for (const candidate of candidates) {
    candidate.fresh = allocateLocal(code);
    for (const item of candidate.loadItems) item.instruction = loadRef(candidate.fresh);
  }

  const castInsertions = [];
  for (const candidate of candidates) {
    for (const copyStore of candidate.copyStores || []) {
      castInsertions.push({ index: copyStore.index, desc: copyStore.desc });
    }
    if (!candidate.desc.startsWith('[L')) continue;
    for (const item of candidate.loadItems) {
      const loadIndex = items.indexOf(item);
      const useIndex = nextInstructionIndex(items, loadIndex);
      if (useIndex >= 0 && isMatchingFieldWrite(items[useIndex], candidate.desc)) {
        castInsertions.push({ index: useIndex, desc: candidate.desc });
      }
    }
  }
  for (const insertion of castInsertions.sort((a, b) => b.index - a.index)) {
    items.splice(insertion.index, 0, { instruction: { op: 'checkcast', arg: checkcastArg(insertion.desc) } });
  }

  let rewrites = 0;
  for (const candidate of candidates.sort((a, b) => b.storeIndex - a.storeIndex)) {
    const storeItems = candidate.storeItems || [candidate.storeItem];
    for (const storeItem of storeItems) {
      const idx = items.indexOf(storeItem);
      if (idx < 0) continue;
      const preserveOriginal = !candidate.noPreserveOriginal && preserveOriginalLocals && (
        isBranchTarget(code, storeItem) ||
        hasUnrewrittenLoadBeforeNextStore(items, idx, candidate.local, candidate.loadItems)
      );
      storeItem.instruction = storeRef(candidate.fresh);
      if (preserveOriginal) {
        items.splice(idx + 1, 0, { instruction: loadRef(candidate.fresh) }, { instruction: storeRef(candidate.local) });
      }
      rewrites += 1;
    }
  }
  return rewrites;
}

function isBranchTarget(code, item) {
  const label = trimLabel(item && item.labelDef);
  if (!label) return false;
  for (const candidate of collectReferencedLabels(code)) {
    if (candidate === label) return true;
  }
  return false;
}

function collectReferencedLabels(code) {
  const out = new Set();
  for (const item of code.codeItems || []) {
    for (const target of branchTargets(item)) {
      const label = trimLabel(target);
      if (label) out.add(label);
    }
  }
  for (const entry of code.exceptionTable || []) {
    for (const value of [entry.startLbl, entry.endLbl, entry.handlerLbl]) {
      const label = trimLabel(value);
      if (label) out.add(label);
    }
  }
  return out;
}

function hasUnrewrittenLoadBeforeNextStore(items, storeIndex, local, rewrittenLoads) {
  for (let i = storeIndex + 1; i < items.length; i += 1) {
    if (aloadLocal(items[i]) === local && !rewrittenLoads.includes(items[i])) return true;
  }
  return false;
}

function collectCastedLoopRanges(code) {
  const items = code.codeItems;
  const out = [];
  for (let i = 1; i < items.length; i += 1) {
    const local = astoreLocal(items[i]);
    if (local == null || countReferenceStores(items, local) !== 3) continue;
    if (op(items[i - 1]) !== 'checkcast') continue;
    if (isHandlerStore(code.exceptionTable, items[i])) continue;
    const desc = referenceDescriptorFromClassName(arg(items[i - 1]));
    if (!isConcreteObjectDescriptor(desc) || desc.startsWith('[L')) continue;
    const top = nextInstructionIndex(items, i);
    if (top < 0) continue;
    const topLabel = trimLabel(items[top] && items[top].labelDef);
    if (!topLabel) continue;
    const backGoto = findBackwardGotoTo(items, top + 1, topLabel);
    if (backGoto < 0) continue;
    const updateStore = previousCastedStore(items, backGoto, local, desc);
    if (updateStore < 0) continue;
    const nextStore = nextStoreIndex(items, backGoto + 1, local);
    if (nextStore < 0) continue;
    if (hasLoadOfLocal(items, backGoto + 1, nextStore, local)) continue;

    const loadItems = [];
    let typedUses = 0;
    let ok = true;
    for (let j = top; j < backGoto; j += 1) {
      if (j !== updateStore && astoreLocal(items[j]) === local) {
        ok = false;
        break;
      }
      if (aloadLocal(items[j]) !== local) continue;
      const useIndex = nextInstructionIndex(items, j);
      if (useIndex < 0) {
        ok = false;
        break;
      }
      if (isNullCompare(items[useIndex])) {
        loadItems.push(items[j]);
        continue;
      }
      if (isMatchingFieldRead(items[useIndex], desc) ||
          isMatchingFieldReceiverWriteDeep(items, j, desc) ||
          isMatchingFieldWrite(items[useIndex], desc)) {
        typedUses += 1;
        loadItems.push(items[j]);
        continue;
      }
      ok = false;
      break;
    }
    if (!ok || typedUses < 2) continue;
    out.push({
      storeIndex: i,
      storeItem: items[i],
      storeItems: [items[i], items[updateStore]],
      local,
      desc,
      explicitCast: true,
      primitiveLocalWrite: false,
      loadItems,
    });
  }
  return out;
}

function collectSingleCastedRangesBeforeReferenceReuse(code, analysis) {
  const items = code.codeItems;
  if (items.length > 10000) return [];
  const out = [];
  for (let i = 1; i < items.length; i += 1) {
    const local = astoreLocal(items[i]);
    if (local == null || op(items[i - 1]) !== 'checkcast') continue;
    if (isHandlerStore(code.exceptionTable, items[i])) continue;
    const desc = referenceDescriptorFromClassName(arg(items[i - 1]));
    if (!isConcreteObjectDescriptor(desc) || desc.startsWith('[L')) continue;
    const storeItems = [items[i]];

    const loadItems = [];
    let typedUses = 0;
    let ok = true;
    let scanStart = i + 1;
    let nextStore = -1;
    for (;;) {
      nextStore = nextStoreIndex(items, scanStart, local);
      if (nextStore < 0) {
        ok = false;
        break;
      }
      for (let j = scanStart; j < nextStore; j += 1) {
        if (aloadLocal(items[j]) !== local) continue;
        const useIndex = nextInstructionIndex(items, j);
        if (useIndex < 0) {
          ok = false;
          break;
        }
        if (isNullCompare(items[useIndex])) {
          loadItems.push(items[j]);
          continue;
        }
        if (astoreLocal(items[useIndex]) != null) {
          typedUses += 1;
          loadItems.push(items[j]);
          continue;
        }
        if (isMatchingFieldRead(items[useIndex], desc) ||
            isMatchingFieldReceiverWrite(items, j, desc) ||
            methodArgumentDescriptorAtUse(items, j) === desc) {
          typedUses += 1;
          loadItems.push(items[j]);
          continue;
        }
        ok = false;
        break;
      }
      if (!ok) break;
      const nextDesc = concreteObjectProducerDescriptor(items, nextStore, analysis) ||
        producerDescriptor(items, previousInstructionIndex(items, nextStore));
      if (nextDesc === desc && previousCastedStore(items, nextStore + 1, local, desc) === nextStore) {
        storeItems.push(items[nextStore]);
        scanStart = nextStore + 1;
        continue;
      }
      break;
    }
    if (!ok) continue;
    const nextDesc = concreteObjectProducerDescriptor(items, nextStore, analysis) ||
      producerDescriptor(items, previousInstructionIndex(items, nextStore));
    if (nextDesc === desc || !isReferenceDescriptor(nextDesc)) continue;
    if (!ok || typedUses === 0 || loadItems.length === 0) continue;
    out.push({
      storeIndex: i,
      storeItem: items[i],
      storeItems,
      local,
      desc,
      explicitCast: true,
      primitiveLocalWrite: false,
      loadItems,
      noPreserveOriginal: true,
    });
  }
  return out;
}

function collectCastedCursorRanges(code, cfg, analysis, dominators) {
  const items = code.codeItems;
  if (items.length > 2000) return [];
  const out = [];
  const writesByLocal = collectLocalWrites(items);
  for (let i = 1; i < items.length; i += 1) {
    const local = astoreLocal(items[i]);
    if (local == null || op(items[i - 1]) !== 'checkcast') continue;
    if (isHandlerStore(code.exceptionTable, items[i])) continue;
    const desc = referenceDescriptorFromClassName(arg(items[i - 1]));
    if (!isConcreteObjectDescriptor(desc) || desc.startsWith('[L')) continue;
    const localWrites = writesByLocal.get(local) || [];
    if (!localWrites.some((idx) => idx > i && isIncompatibleLocalWrite(items, idx, desc))) continue;
    const updateStore = nextSameCastedStore(items, localWrites, i + 1, desc);
    if (updateStore < 0) continue;
    const nextWrite = nextLocalWriteFrom(items, localWrites, updateStore + 1);
    if (nextWrite < 0 || !isIncompatibleLocalWrite(items, nextWrite, desc)) continue;

    const loadItems = [];
    let typedUses = 0;
    let ok = true;
    for (let j = i + 1; j < nextWrite; j += 1) {
      if (j !== updateStore && astoreLocal(items[j]) === local) {
        ok = false;
        break;
      }
      if (aloadLocal(items[j]) !== local) continue;
      const reaching = analysis.before[j] && analysis.before[j].get(local);
      if (!reaching || reaching.size === 0) {
        ok = false;
        break;
      }
      const defs = [...reaching].map((defId) => analysis.defs.get(defId));
      if (!defs.every((def) => def && (def.index === i || def.index === updateStore))) {
        ok = false;
        break;
      }
      if (dominators && !defs.some((def) => instructionDominates(cfg, dominators, def.index, j))) {
        ok = false;
        break;
      }
      const useIndex = nextInstructionIndex(items, j);
      if (useIndex < 0) {
        ok = false;
        break;
      }
      if (isNullCompare(items[useIndex])) {
        loadItems.push(items[j]);
        continue;
      }
      if (isMatchingFieldRead(items[useIndex], desc) ||
          isMatchingFieldReceiverWrite(items, j, desc) ||
          methodArgumentDescriptorAtUse(items, j) === desc) {
        typedUses += 1;
        loadItems.push(items[j]);
        continue;
      }
      ok = false;
      break;
    }
    if (!ok || typedUses === 0 || loadItems.length === 0) continue;
    out.push({
      storeIndex: i,
      storeItem: items[i],
      storeItems: [items[i], items[updateStore]],
      local,
      desc,
      explicitCast: true,
      primitiveLocalWrite: primitiveStoreLocal(items[nextWrite]) === local || iincLocal(items[nextWrite]) === local,
      loadItems,
      noPreserveOriginal: true,
    });
  }
  return out;
}

function collectLocalWrites(items) {
  const out = new Map();
  for (let i = 0; i < items.length; i += 1) {
    const local = astoreLocal(items[i]) || primitiveStoreLocal(items[i]) || iincLocal(items[i]);
    if (local == null) continue;
    if (!out.has(local)) out.set(local, []);
    out.get(local).push(i);
  }
  return out;
}

function nextSameCastedStore(items, localWrites, start, desc) {
  for (const i of localWrites) {
    if (i < start) continue;
    if (astoreLocal(items[i]) == null) return -1;
    const prev = previousInstructionIndex(items, i);
    if (prev >= 0 && op(items[prev]) === 'checkcast' &&
        referenceDescriptorFromClassName(arg(items[prev])) === desc) {
      return i;
    }
    return -1;
  }
  return -1;
}

function nextLocalWriteFrom(items, localWrites, start) {
  for (const i of localWrites) {
    if (i >= start) return i;
  }
  return -1;
}

function isIncompatibleLocalWrite(items, index, desc) {
  const localWrite = astoreLocal(items[index]);
  if (primitiveStoreLocal(items[index]) != null || iincLocal(items[index]) != null) return true;
  if (localWrite == null) return false;
  const produced = concreteObjectProducerDescriptor(items, index, null);
  return produced !== desc;
}

function countReferenceStores(items, local) {
  let count = 0;
  for (const item of items) {
    if (astoreLocal(item) === local) count += 1;
  }
  return count;
}

function findBackwardGotoTo(items, start, label) {
  for (let i = start; i < items.length; i += 1) {
    if (op(items[i]) !== 'goto') continue;
    const target = trimLabel(arg(items[i]));
    if (target === label) return i;
  }
  return -1;
}

function previousCastedStore(items, before, local, desc) {
  for (let i = before - 1; i >= 0; i -= 1) {
    if (astoreLocal(items[i]) !== local) continue;
    const prev = previousInstructionIndex(items, i);
    if (prev >= 0 && op(items[prev]) === 'checkcast' &&
        referenceDescriptorFromClassName(arg(items[prev])) === desc) {
      return i;
    }
    return -1;
  }
  return -1;
}

function hasLoadOfLocal(items, start, end, local) {
  for (let i = start; i < end; i += 1) {
    if (aloadLocal(items[i]) === local) return true;
  }
  return false;
}

function collectLinearExplicitCastRanges(code) {
  const items = code.codeItems;
  const refs = labelReferencesWithSources(code);
  const out = [];
  for (let i = 1; i < items.length; i += 1) {
    const local = astoreLocal(items[i]);
    if (local == null || op(items[i - 1]) !== 'checkcast') continue;
    if (isHandlerStore(code.exceptionTable, items[i])) continue;
    const desc = referenceDescriptorFromClassName(arg(items[i - 1]));
    if (!isConcreteObjectDescriptor(desc) || desc.startsWith('[L')) continue;
    const end = nextLocalWriteIndex(items, i + 1, local);
    if (end < 0) continue;
    const loadItems = [];
    const copyStores = [];
    let typedUses = 0;
    let ok = true;
    for (let j = i + 1; j < end; j += 1) {
      if (astoreLocal(items[j]) === local || primitiveStoreLocal(items[j]) === local || iincLocal(items[j]) === local) {
        ok = false;
        break;
      }
      if (aloadLocal(items[j]) !== local) continue;
      const useIndex = nextInstructionIndex(items, j);
      if (useIndex < 0) {
        ok = false;
        break;
      }
      const copiedLocal = astoreLocal(items[useIndex]);
      if (isNullCompare(items[useIndex])) {
        // Keep the load in the range, but require a typed consumer elsewhere.
      } else if (isMatchingFieldRead(items[useIndex], desc) ||
          isMatchingFieldReceiverWrite(items, j, desc)) {
        typedUses += 1;
      } else if (copiedLocal != null && copiedLocal !== local &&
          copiedLocalHasMatchingTypedUses(items, useIndex, copiedLocal, desc)) {
        typedUses += 1;
        copyStores.push({ index: useIndex, desc });
      } else {
        ok = false;
        break;
      }
      loadItems.push(items[j]);
    }
    if (!ok || typedUses === 0) continue;
    const lastLoad = items.indexOf(loadItems[loadItems.length - 1]);
    if (hasIncomingBranchFromOutside(items, refs, i + 1, lastLoad + 1)) continue;
    out.push({
      storeIndex: i,
      storeItem: items[i],
      local,
      desc,
      explicitCast: true,
      primitiveLocalWrite: false,
      loadItems,
      copyStores,
    });
  }
  return out;
}

function copiedLocalHasMatchingTypedUses(items, storeIndex, local, desc) {
  let typedUses = 0;
  const end = nextStoreIndex(items, storeIndex + 1, local);
  const limit = end < 0 ? items.length : end;
  for (let i = storeIndex + 1; i < limit; i += 1) {
    if (aloadLocal(items[i]) !== local) continue;
    const useIndex = nextInstructionIndex(items, i);
    if (useIndex < 0) return false;
    if (isNullCompare(items[useIndex])) continue;
    const useDesc = isMatchingFieldRead(items[useIndex], desc) ||
      isMatchingFieldReceiverWrite(items, i, desc)
      ? desc
      : methodArgumentDescriptorAtUse(items, i);
    if (useDesc !== desc) return false;
    typedUses += 1;
  }
  return typedUses > 0;
}

function nextStoreIndex(items, start, local) {
  for (let i = start; i < items.length; i += 1) {
    if (astoreLocal(items[i]) === local) return i;
  }
  return -1;
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
  if (insn.op === 'tableswitch' || insn.op === 'lookupswitch') {
    const out = [];
    const value = insn.arg;
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (Array.isArray(entry)) out.push(entry[entry.length - 1]);
        else if (typeof entry === 'string') out.push(entry);
      }
    }
    if (Array.isArray(insn.labels)) out.push(...insn.labels);
    if (insn.defaultLbl) out.push(insn.defaultLbl);
    return out;
  }
  return typeof insn.arg === 'string' ? [insn.arg] : [];
}

function mergeCandidates(...groups) {
  const byKey = new Map();
  for (const group of groups) {
    for (const candidate of group) {
      const key = `${candidate.storeIndex}:${candidate.local}`;
      let existing = byKey.get(key);
      if (!existing) {
        existing = { ...candidate, loadItems: [], copyStores: [] };
        if (candidate.storeItems) existing.storeItems = [...candidate.storeItems];
        byKey.set(key, existing);
      }
      for (const storeItem of candidate.storeItems || []) {
        if (!existing.storeItems) existing.storeItems = [existing.storeItem];
        if (!existing.storeItems.includes(storeItem)) existing.storeItems.push(storeItem);
      }
      for (const item of candidate.loadItems || []) {
        if (!existing.loadItems.includes(item)) existing.loadItems.push(item);
      }
      for (const copyStore of candidate.copyStores || []) {
        if (!existing.copyStores.some((entry) => entry.index === copyStore.index && entry.desc === copyStore.desc)) {
          existing.copyStores.push(copyStore);
        }
      }
    }
  }
  return [...byKey.values()].filter((candidate) => candidate.loadItems.length > 0);
}

function collectCandidates(code, cfg, analysis, dominators) {
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
    if (dominators && !instructionDominates(cfg, dominators, def.index, i)) continue;
    if (isHandlerStore(code.exceptionTable, items[def.index])) continue;
    const explicitCast = hasExplicitCastProducer(items, def.index);
    const primitiveLocalWrite = hasPrimitiveLocalWrite(items, local);
    if (!hasConflictingReferenceStore(items, def.index, local) && !(explicitCast && primitiveLocalWrite)) continue;
    if (primitiveLocalWrite && !explicitCast) continue;
    const desc = concreteObjectProducerDescriptor(items, def.index, analysis);
    if (!desc) continue;
    if (hasNullStore(items, def.index, local) && !explicitCast) continue;
    const key = String(defId);
    let candidate = byStore.get(key);
    if (!candidate) {
      candidate = {
        storeIndex: def.index,
        storeItem: items[def.index],
        local,
        desc,
        explicitCast,
        primitiveLocalWrite,
        loadItems: [],
      };
      byStore.set(key, candidate);
    }
    candidate.loadItems.push(items[i]);
  }
  return [...byStore.values()].filter((candidate) =>
    candidate.loadItems.length > 0 && hasOnlyTypedSimpleUses(items, candidate));
}

function concreteObjectProducerDescriptor(items, storeIndex, analysis, seen = new Set()) {
  if (seen.has(storeIndex)) return null;
  seen.add(storeIndex);
  const prev = previousInstructionIndex(items, storeIndex);
  if (prev < 0) return null;
  const desc = producerDescriptor(items, prev);
  if (isConcreteObjectDescriptor(desc)) return desc;
  if (op(items[prev]) === 'dup') {
    const duplicatedIndex = previousInstructionIndex(items, prev);
    if (duplicatedIndex >= 0) {
      const duplicatedDesc = producerDescriptor(items, duplicatedIndex);
      if (isConcreteObjectDescriptor(duplicatedDesc)) return duplicatedDesc;
      const duplicatedLocal = aloadLocal(items[duplicatedIndex]);
      if (duplicatedLocal != null && analysis) {
        const reaching = analysis.before[duplicatedIndex] && analysis.before[duplicatedIndex].get(duplicatedLocal);
        if (reaching && reaching.size === 1) {
          const [defId] = reaching;
          const def = analysis.defs.get(defId);
          if (def) {
            const desc = concreteObjectProducerDescriptor(items, def.index, analysis, seen);
            if (isConcreteObjectDescriptor(desc)) return desc;
          }
        }
      }
      if (duplicatedLocal != null) {
        for (let j = duplicatedIndex - 1; j >= 0; j -= 1) {
          if (primitiveStoreLocal(items[j]) === duplicatedLocal || iincLocal(items[j]) === duplicatedLocal) break;
          if (astoreLocal(items[j]) !== duplicatedLocal) continue;
          const desc = concreteObjectProducerDescriptor(items, j, analysis, seen);
          if (isConcreteObjectDescriptor(desc)) return desc;
          break;
        }
      }
    }
  }
  if (astoreLocal(items[prev]) != null) {
    const siblingDesc = concreteObjectProducerDescriptor(items, prev, analysis, seen);
    if (isConcreteObjectDescriptor(siblingDesc)) return siblingDesc;
  }
  const sourceLocal = aloadLocal(items[prev]);
  if (sourceLocal == null || !analysis) return null;
  const reaching = analysis.before[prev] && analysis.before[prev].get(sourceLocal);
  if (!reaching || reaching.size !== 1) return null;
  const [defId] = reaching;
  if (typeof defId !== 'number') return null;
  const def = analysis.defs.get(defId);
  if (!def) return null;
  return concreteObjectProducerDescriptor(items, def.index, analysis, seen);
}

function producerDescriptor(items, index) {
  const item = items[index];
  const insn = item && item.instruction;
  if (!insn || typeof insn !== 'object') return null;
  if (insn.op === 'getstatic' || insn.op === 'getfield') {
    const ref = insn.arg;
    return Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
  }
  if (insn.op === 'invokespecial' && isConstructorRef(insn.arg)) {
    const owner = constructorOwnerFromNewDup(items, index);
    return isConcreteClassName(owner) ? `L${owner};` : null;
  }
  if (/^invoke/.test(insn.op || '')) {
    const ref = insn.arg;
    const desc = Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
    return typeof desc === 'string' ? desc.slice(desc.lastIndexOf(')') + 1) : null;
  }
  if (insn.op === 'checkcast') {
    const target = insn.arg;
    return referenceDescriptorFromClassName(target);
  }
  if (insn.op === 'anewarray') {
    const target = insn.arg;
    return isConcreteClassName(target) ? `[L${target};` : null;
  }
  return null;
}

function isConstructorRef(ref) {
  return Array.isArray(ref) && Array.isArray(ref[2]) && ref[2][0] === '<init>';
}

function constructorOwnerFromNewDup(items, invokespecialIndex) {
  const dupIndex = previousInstructionIndex(items, invokespecialIndex);
  if (dupIndex < 0 || op(items[dupIndex]) !== 'dup') return null;
  const newIndex = previousInstructionIndex(items, dupIndex);
  if (newIndex < 0 || op(items[newIndex]) !== 'new') return null;
  return arg(items[newIndex]);
}

function isConcreteObjectDescriptor(desc) {
  if (typeof desc !== 'string' || !/^(?:L|\[L)[^;]+;$/.test(desc)) return false;
  return desc !== 'Ljava/lang/Object;' && desc !== 'Ljava/lang/Throwable;' &&
    desc !== 'Ljava/lang/Exception;' && desc !== '[Ljava/lang/Object;';
}

function isReferenceDescriptor(desc) {
  return typeof desc === 'string' && (desc.startsWith('L') || desc.startsWith('['));
}

function isConcreteClassName(target) {
  return typeof target === 'string' && target !== 'java/lang/Object' &&
    target !== 'java/lang/Throwable' && target !== 'java/lang/Exception' &&
    !target.startsWith('[');
}

function referenceDescriptorFromClassName(target) {
  if (isConcreteClassName(target)) return `L${target};`;
  if (typeof target === 'string' && /^\[L[^;]+;$/.test(target) && target !== '[Ljava/lang/Object;') {
    return target;
  }
  return null;
}

function hasOnlyTypedSimpleUses(items, candidate) {
  let typedUses = 0;
  for (const loadItem of candidate.loadItems) {
    const loadIndex = items.indexOf(loadItem);
    const useIndex = nextInstructionIndex(items, loadIndex);
    if (useIndex < 0) return false;
    const use = items[useIndex];
    if (isNullCompare(use)) continue;
    if (isMatchingFieldRead(use, candidate.desc)) {
      typedUses += 1;
      continue;
    }
    if (isMatchingFieldReceiverWrite(items, loadIndex, candidate.desc)) {
      typedUses += 1;
      continue;
    }
    if (isMatchingFieldWrite(use, candidate.desc)) {
      typedUses += 1;
      continue;
    }
    if (isCompatibleObjectArrayInvoke(items, loadIndex, candidate.desc)) continue;
    return false;
  }
  return typedUses > 0;
}

function isNullCompare(item) {
  const itemOp = op(item);
  return itemOp === 'ifnull' || itemOp === 'ifnonnull' ||
    itemOp === 'if_acmpeq' || itemOp === 'if_acmpne';
}

function isMatchingFieldRead(item, desc) {
  if (op(item) !== 'getfield') return false;
  const ref = arg(item);
  return Array.isArray(ref) && descriptorOwner(desc) === ref[1];
}

function isMatchingFieldWrite(item, desc) {
  const itemOp = op(item);
  if (itemOp !== 'putstatic' && itemOp !== 'putfield') return false;
  const ref = arg(item);
  return Array.isArray(ref) && Array.isArray(ref[2]) && ref[2][1] === desc;
}

function isCompatibleObjectArrayInvoke(items, loadIndex, desc) {
  if (typeof desc !== 'string' || !desc.startsWith('[L')) return false;
  for (let i = nextInstructionIndex(items, loadIndex), seen = 0;
    i >= 0 && seen < 6;
    i = nextInstructionIndex(items, i), seen += 1) {
    const itemOp = op(items[i]);
    if (/^invoke/.test(itemOp || '')) {
      const ref = arg(items[i]);
      const methodDesc = Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
      return typeof methodDesc === 'string' &&
        (methodDesc.includes(desc) || methodDesc.includes('[Ljava/lang/Object;'));
    }
    if (!isSimpleFieldValueProducer(items[i])) return false;
  }
  return false;
}

function methodArgumentDescriptorAtUse(items, loadIndex) {
  const marker = Symbol('tracked-local');
  const suffixStack = [marker];
  for (let i = nextInstructionIndex(items, loadIndex), seen = 0;
    i >= 0 && seen < 8;
    i = nextInstructionIndex(items, i), seen += 1) {
    const itemOp = op(items[i]);
    if (/^invoke/.test(itemOp || '')) {
      const ref = arg(items[i]);
      const methodDesc = Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
      const params = methodParameterDescriptors(methodDesc);
      if (!params) return null;
      const markerIndex = suffixStack.indexOf(marker);
      if (markerIndex < 0) return null;
      const fromTop = suffixStack.length - 1 - markerIndex;
      if (fromTop < params.length) return params[params.length - 1 - fromTop];
      if (itemOp !== 'invokestatic' && fromTop === params.length) {
        return Array.isArray(ref) && typeof ref[1] === 'string' ? `L${ref[1]};` : null;
      }
      return null;
    }
    if (!applySimpleStackEffect(suffixStack, items[i])) return null;
  }
  return null;
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
  if (itemOp === 'arraylength') {
    if (stack.length > 0) stack.pop();
    stack.push(Symbol('value'));
    return true;
  }
  if (/^(?:i|l|f|d|a)aload$/.test(itemOp || '')) {
    if (stack.length > 0) stack.pop();
    if (stack.length > 0) stack.pop();
    stack.push(Symbol('value'));
    return true;
  }
  if (itemOp === 'pop') {
    if (stack.length > 0) stack.pop();
    return true;
  }
  if (/^(?:i|l|f|d|a)store(?:_[0-3])?$/.test(itemOp || '')) {
    if (stack.length > 0) stack.pop();
    return true;
  }
  if (/^(?:i|l|f|d)(?:add|sub|mul|div|rem)$/.test(itemOp || '')) {
    if (stack.length > 0) stack.pop();
    if (stack.length > 0) stack.pop();
    stack.push(Symbol('value'));
    return true;
  }
  return false;
}

function methodParameterDescriptors(methodDesc) {
  if (typeof methodDesc !== 'string' || !methodDesc.startsWith('(')) return null;
  const out = [];
  let i = 1;
  while (i < methodDesc.length && methodDesc[i] !== ')') {
    const start = i;
    while (methodDesc[i] === '[') i += 1;
    if (methodDesc[i] === 'L') {
      const end = methodDesc.indexOf(';', i);
      if (end < 0) return null;
      i = end + 1;
    } else {
      i += 1;
    }
    out.push(methodDesc.slice(start, i));
  }
  return i < methodDesc.length && methodDesc[i] === ')' ? out : null;
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

function isMatchingFieldReceiverWriteDeep(items, loadIndex, desc) {
  for (let i = nextInstructionIndex(items, loadIndex), seen = 0;
    i >= 0 && seen < 24;
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

function hasConflictingReferenceStore(items, selfIndex, local) {
  for (let i = 0; i < items.length; i += 1) {
    if (i === selfIndex) continue;
    if (astoreLocal(items[i]) === local) return true;
  }
  return false;
}

function hasNullStore(items, selfIndex, local) {
  for (let i = 0; i < items.length; i += 1) {
    if (i === selfIndex || astoreLocal(items[i]) !== local) continue;
    const prev = previousInstructionIndex(items, i);
    if (prev >= 0 && op(items[prev]) === 'aconst_null') return true;
  }
  return false;
}

function hasExplicitCastProducer(items, storeIndex) {
  const prev = previousInstructionIndex(items, storeIndex);
  return prev >= 0 && op(items[prev]) === 'checkcast';
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

function descriptorOwner(desc) {
  return typeof desc === 'string' && /^L[^;]+;$/.test(desc) ? desc.slice(1, -1) : null;
}

function checkcastArg(desc) {
  return typeof desc === 'string' && /^L[^;]+;$/.test(desc) ? desc.slice(1, -1) : desc;
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
  const insn = item && item.instruction;
  return insn && typeof insn === 'object' ? insn.arg : null;
}

function trimLabel(label) {
  return typeof label === 'string' ? label.replace(/:$/, '') : null;
}

module.exports = {
  runSplitConcreteObjectReachingLocal,
  splitCode,
  collectLinearExplicitCastRanges,
};

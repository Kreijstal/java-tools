'use strict';

const {
  buildCfg,
  reachingDefinitions,
} = require('./splitArrayReachingLocal');

function runSplitTypedReusedLocals(astRoot, options = {}) {
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
  const maxIterations = options.maxIterations || 1;
  let total = 0;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const rewrites = splitCodeOnce(code, options);
    if (rewrites === 0) break;
    total += rewrites;
  }
  return total;
}

function splitCodeOnce(code, options = {}) {
  const items = code.codeItems;
  if (items.length < (options.minMethodItems || 0)) return 0;
  if (items.length > (options.maxMethodItems || 10000)) return 0;
  const cfg = buildCfg(code);
  if (!cfg.blocks.length) return 0;
  if (options.requireSimpleReferenceReuseTopology && hasRiskyReferenceReuseTopology(code)) return 0;
  const analysis = reachingDefinitions(code, cfg);
  let candidates = collectCandidates(code, analysis, options);
  const maxCandidates = options.maxCandidates || 64;
  if (candidates.length > maxCandidates) {
    candidates = candidates.filter((candidate) =>
      isPrimitiveArrayCandidate(candidate) || isConcreteReferenceArrayCandidate(candidate));
    if (candidates.length === 0 || candidates.length > maxCandidates) return 0;
  }
  const maxFreshLocalIndex = options.maxFreshLocalIndex == null ? 255 : Number(options.maxFreshLocalIndex);
  const currentLocalCount = Number(code.locals || code.localsSize || 0);
  if (Number.isFinite(maxFreshLocalIndex) && Number.isFinite(currentLocalCount) &&
    currentLocalCount + candidates.length - 1 > maxFreshLocalIndex) {
    return 0;
  }

  for (const candidate of candidates) {
    candidate.fresh = allocateLocal(code);
    for (const load of candidate.loads) {
      load.instruction = loadRef(candidate.fresh);
    }
  }

  let rewrites = 0;
  for (const candidate of candidates.sort((a, b) => b.storeIndex - a.storeIndex)) {
    const storeIndex = items.indexOf(candidate.storeItem);
    if (storeIndex < 0) continue;
    const preserveOriginal = options.preserveOriginalLocals && (
      isBranchTarget(code, candidate.storeItem) ||
      candidate.reachesUnrewrittenLoad ||
      hasUnrewrittenLoadBeforeNextStore(items, storeIndex, candidate.local, candidate.loads)
    );
    candidate.storeItem.instruction = storeRef(candidate.fresh);
    if (preserveOriginal) {
      items.splice(storeIndex + 1, 0, { instruction: loadRef(candidate.fresh) }, { instruction: storeRef(candidate.local) });
    }
    rewrites += 1;
  }
  return rewrites;
}

function hasRiskyReferenceReuseTopology(code) {
  const items = code.codeItems || [];
  const labels = new Map();
  for (let i = 0; i < items.length; i += 1) {
    const label = trimLabel(items[i] && items[i].labelDef);
    if (label) labels.set(label, i);
  }

  const refs = new Map();
  let branchCount = 0;
  let backwardBranches = 0;
  for (let i = 0; i < items.length; i += 1) {
    const target = branchTarget(items[i]);
    const label = trimLabel(target);
    if (!label) continue;
    branchCount += 1;
    const targetIndex = labels.get(label);
    if (targetIndex != null && targetIndex < i) backwardBranches += 1;
    let incoming = refs.get(label);
    if (!incoming) {
      incoming = [];
      refs.set(label, incoming);
    }
    incoming.push(i);
  }

  let sharedLabels = 0;
  let fallthroughSharedLabels = 0;
  let highlySharedLabels = 0;
  for (const [label, incoming] of refs.entries()) {
    if (incoming.length < 2) continue;
    sharedLabels += 1;
    if (incoming.length >= 6) highlySharedLabels += 1;
    const targetIndex = labels.get(label);
    if (targetIndex != null && hasFallthroughPredecessor(items, targetIndex)) {
      fallthroughSharedLabels += 1;
    }
  }

  if (branchCount >= 80 && sharedLabels >= 10 && fallthroughSharedLabels >= 2) return true;
  if (branchCount >= 120 && highlySharedLabels >= 2) return true;
  if (backwardBranches >= 12 && sharedLabels >= 8 && fallthroughSharedLabels >= 1) return true;
  return false;
}

function collectCandidates(code, analysis, options) {
  const items = code.codeItems;
  const byDef = new Map();
  for (let i = 0; i < items.length; i += 1) {
    const local = aloadLocal(items[i]);
    if (local == null) continue;
    const expected = expectedTypeForLoad(items, i);
    if (!expected) continue;
    const reaching = analysis.before[i] && analysis.before[i].get(local);
    if (!reaching || reaching.size !== 1) continue;
    const [defId] = reaching;
    if (typeof defId !== 'number') continue;
    const def = analysis.defs.get(defId);
    if (!def || def.local !== local || isHandlerStore(code.exceptionTable, items[def.index])) continue;
    const produced = producedTypeForStore(items, def.index, analysis);
    if (produced && !typesCompatible(produced, expected)) continue;
    const key = String(defId);
    let candidate = byDef.get(key);
    if (!candidate) {
      candidate = {
        defId,
        storeIndex: def.index,
        storeItem: items[def.index],
        local,
        expected,
        produced,
        loads: [],
      };
      byDef.set(key, candidate);
    }
    candidate.loads.push(items[i]);
  }

  return [...byDef.values()].map((candidate) => ({
    ...candidate,
    loads: (shouldExtendToAllReachedLoads(candidate)
      ? extendToAllReachedLoads(items, analysis, candidate)
      : candidate.loads).filter((load) =>
      !hasPrimitiveLocalWriteBetween(items, candidate.storeIndex, items.indexOf(load), candidate.local)),
  })).map((candidate) => ({
    ...candidate,
    // A later conditional store can appear before a join in linear bytecode
    // without dominating that join. In that case this definition still
    // reaches an unrewritten load along the path that skips the store, so the
    // original local must retain a copy of the split value.
    reachesUnrewrittenLoad: reachesUnrewrittenLoad(items, analysis, candidate),
  })).filter((candidate) => {
    if (candidate.loads.length === 0) return false;
    if (options.skipIfReachesUnrewrittenLoad && candidate.reachesUnrewrittenLoad) return false;
    if (!hasOtherReferenceStore(items, candidate.storeIndex, candidate.local) && !isPrimitiveArrayDescriptor(candidate.produced)) return false;
    if (hasPrimitiveLocalWriteBeforeLastCandidateLoad(items, candidate.storeIndex, candidate.local, candidate.loads)) return false;
    if (options.requireAllLoadsTyped && !allLoadsTypedForDef(items, analysis, candidate)) return false;
    return true;
  });
}

function reachesUnrewrittenLoad(items, analysis, candidate) {
  const rewrittenLoads = new Set(candidate.loads);
  for (let i = candidate.storeIndex + 1; i < items.length; i += 1) {
    if (aloadLocal(items[i]) !== candidate.local || rewrittenLoads.has(items[i])) continue;
    const reaching = analysis.before[i] && analysis.before[i].get(candidate.local);
    if (reaching && reaching.has(candidate.defId)) return true;
  }
  return false;
}

function expectedTypeForLoad(items, index) {
  const invokeExpected = expectedTypeFromNextInvoke(items, index);
  if (invokeExpected) return invokeExpected;
  for (let i = nextInstructionIndex(items, index), seen = 0; i >= 0 && seen < 8; i = nextInstructionIndex(items, i), seen += 1) {
    const itemOp = op(items[i]);
    if (itemOp === 'faload' || itemOp === 'fastore') return '[F';
    if (itemOp === 'daload' || itemOp === 'dastore') return '[D';
    if (itemOp === 'laload' || itemOp === 'lastore') return '[J';
    if (itemOp === 'iaload' || itemOp === 'iastore') return '[I';
    if (itemOp === 'baload' || itemOp === 'bastore') return '[B';
    if (itemOp === 'caload' || itemOp === 'castore') return '[C';
    if (itemOp === 'saload' || itemOp === 'sastore') return '[S';
    if (itemOp === 'aastore') return expectedTypeFromArrayStoreValue(items, index) || '[Ljava/lang/Object;';
    if (itemOp === 'aaload') return expectedTypeFromCopiedAaloadElement(items, index) || '[Ljava/lang/Object;';
    if (itemOp === 'arraylength') return '[Ljava/lang/Object;';
    if (itemOp === 'getfield') {
      const ref = arg(items[i]);
      return Array.isArray(ref) ? `L${ref[1]};` : null;
    }
    if (itemOp === 'checkcast') return referenceDescriptorFromClassName(arg(items[i]));
    if (!isSimpleStackProducer(items[i])) return null;
  }
  return null;
}

function expectedTypeFromArrayStoreValue(items, loadIndex) {
  const indexProducer = previousInstructionIndex(items, loadIndex);
  if (indexProducer < 0) return null;
  const arrayProducer = previousInstructionIndex(items, indexProducer);
  if (arrayProducer < 0) return null;
  const desc = producedTypeForInstruction(items, arrayProducer, null, new Set());
  return arrayElementDescriptor(desc);
}

function expectedTypeFromCopiedAaloadElement(items, loadIndex) {
  const indexProducer = nextInstructionIndex(items, loadIndex);
  if (indexProducer < 0 || !isSimpleStackProducer(items[indexProducer])) return null;
  const aaloadIndex = nextInstructionIndex(items, indexProducer);
  if (aaloadIndex < 0 || op(items[aaloadIndex]) !== 'aaload') return null;
  const storeIndex = nextInstructionIndex(items, aaloadIndex);
  const copiedLocal = storeIndex >= 0 ? astoreLocal(items[storeIndex]) : null;
  if (copiedLocal == null) return null;
  const element = firstPrimitiveArrayUseDescriptor(items, storeIndex + 1, copiedLocal);
  return element ? `[${element}` : null;
}

function firstPrimitiveArrayUseDescriptor(items, start, local) {
  for (let i = start; i < items.length; i += 1) {
    if (astoreLocal(items[i]) === local || primitiveStoreLocal(items[i]) === local || iincLocal(items[i]) === local) return null;
    if (aloadLocal(items[i]) !== local) continue;
    const desc = primitiveArrayUseDescriptor(items, i);
    if (desc) return desc;
  }
  return null;
}

function primitiveArrayUseDescriptor(items, loadIndex) {
  for (let i = nextInstructionIndex(items, loadIndex), seen = 0; i >= 0 && seen < 5; i = nextInstructionIndex(items, i), seen += 1) {
    const itemOp = op(items[i]);
    if (itemOp === 'iaload' || itemOp === 'iastore') return '[I';
    if (itemOp === 'faload' || itemOp === 'fastore') return '[F';
    if (itemOp === 'daload' || itemOp === 'dastore') return '[D';
    if (itemOp === 'laload' || itemOp === 'lastore') return '[J';
    if (itemOp === 'baload' || itemOp === 'bastore') return '[B';
    if (itemOp === 'caload' || itemOp === 'castore') return '[C';
    if (itemOp === 'saload' || itemOp === 'sastore') return '[S';
    if (!isSimpleStackProducer(items[i])) return null;
  }
  return null;
}

function expectedTypeFromNextInvoke(items, loadIndex) {
  for (let i = nextInstructionIndex(items, loadIndex), seen = 0; i >= 0 && seen < 32; i = nextInstructionIndex(items, i), seen += 1) {
    if (/^invoke/.test(op(items[i]) || '')) return expectedTypeFromInvokeUse(items, loadIndex, i);
  }
  return null;
}

function expectedTypeFromInvokeUse(items, loadIndex, invokeIndex) {
  const ref = arg(items[invokeIndex]);
  const desc = Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
  const args = argumentDescriptors(desc);
  if (!args) return null;
  const owner = Array.isArray(ref) && typeof ref[1] === 'string' ? ref[1] : null;
  const hasReceiver = !/^invokestatic/.test(op(items[invokeIndex]) || '');

  const marker = { marker: true };
  const stack = [marker];
  for (let i = nextInstructionIndex(items, loadIndex); i >= 0 && i < invokeIndex; i = nextInstructionIndex(items, i)) {
    const result = simulateStackEffect(items[i], stack);
    if (!result) return null;
  }

  for (let argIndex = args.length - 1, stackIndex = stack.length - 1; argIndex >= 0 && stackIndex >= 0; argIndex -= 1, stackIndex -= 1) {
    if (stack[stackIndex] === marker) return args[argIndex];
  }
  const receiverIndex = stack.length - args.length - 1;
  if (hasReceiver && receiverIndex >= 0 && stack[receiverIndex] === marker && owner) {
    return `L${owner};`;
  }
  return null;
}

function producedTypeForStore(items, storeIndex, analysis, seen = new Set()) {
  const prev = previousInstructionIndex(items, storeIndex);
  if (prev < 0) return null;
  const prevOp = op(items[prev]);
  if (prevOp === 'newarray') return primitiveArrayDescriptor(arg(items[prev]));
  if (prevOp === 'anewarray') return arrayDescriptorFromAnewarray(arg(items[prev]));
  if (prevOp === 'multianewarray') return arrayDescriptorFromMultianewarray(arg(items[prev]));
  if (prevOp === 'checkcast') return referenceDescriptorFromClassName(arg(items[prev]));
  if (prevOp === 'getfield' || prevOp === 'getstatic') {
    const ref = arg(items[prev]);
    return Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
  }
  if (prevOp === 'aaload') return arrayLoadProducedType(items, prev, analysis, seen);
  if (/^invoke/.test(prevOp || '')) {
    const ref = arg(items[prev]);
    if (Array.isArray(ref) && Array.isArray(ref[2]) && ref[2][0] === '<init>' && typeof ref[1] === 'string') {
      return `L${ref[1]};`;
    }
    const desc = Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
    return returnDescriptor(desc);
  }
  const sourceLocal = aloadLocal(items[prev]);
  if (sourceLocal == null || !analysis) return null;
  const key = `${storeIndex}:${sourceLocal}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const reaching = analysis.before[prev] && analysis.before[prev].get(sourceLocal);
  if (!reaching || reaching.size !== 1) return null;
  const [defId] = reaching;
  const def = analysis.defs.get(defId);
  return def ? producedTypeForStore(items, def.index, analysis, seen) : null;
}

function arrayLoadProducedType(items, loadIndex, analysis, seen) {
  const indexProducer = previousInstructionIndex(items, loadIndex);
  if (indexProducer < 0) return null;
  const arrayProducer = previousInstructionIndex(items, indexProducer);
  if (arrayProducer < 0) return null;
  const arrayType = producedTypeForInstruction(items, arrayProducer, analysis, seen);
  return arrayElementDescriptor(arrayType);
}

function producedTypeForInstruction(items, index, analysis, seen) {
  const itemOp = op(items[index]);
  if (itemOp === 'newarray') return primitiveArrayDescriptor(arg(items[index]));
  if (itemOp === 'anewarray') return arrayDescriptorFromAnewarray(arg(items[index]));
  if (itemOp === 'multianewarray') return arrayDescriptorFromMultianewarray(arg(items[index]));
  if (itemOp === 'checkcast') return referenceDescriptorFromClassName(arg(items[index]));
  if (itemOp === 'getfield' || itemOp === 'getstatic') {
    const ref = arg(items[index]);
    return Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
  }
  if (itemOp === 'aaload') return arrayLoadProducedType(items, index, analysis, seen);
  if (/^invoke/.test(itemOp || '')) {
    const ref = arg(items[index]);
    if (Array.isArray(ref) && Array.isArray(ref[2]) && ref[2][0] === '<init>' && typeof ref[1] === 'string') {
      return `L${ref[1]};`;
    }
    const desc = Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
    return returnDescriptor(desc);
  }
  const sourceLocal = aloadLocal(items[index]);
  if (sourceLocal == null || !analysis) return null;
  const key = `insn:${index}:${sourceLocal}`;
  if (seen && seen.has(key)) return null;
  if (seen) seen.add(key);
  const reaching = analysis.before[index] && analysis.before[index].get(sourceLocal);
  if (!reaching || reaching.size !== 1) return null;
  const [defId] = reaching;
  const def = analysis.defs.get(defId);
  return def ? producedTypeForStore(items, def.index, analysis, seen) : null;
}

function shouldExtendToAllReachedLoads(candidate) {
  return isNonArrayReferenceDescriptor(candidate.produced);
}

function isNonArrayReferenceDescriptor(desc) {
  return typeof desc === 'string' && desc.startsWith('L') && desc.endsWith(';');
}

function extendToAllReachedLoads(items, analysis, candidate) {
  const out = [...candidate.loads];
  const seen = new Set(out);
  for (let i = candidate.storeIndex + 1; i < items.length; i += 1) {
    if (astoreLocal(items[i]) === candidate.local) break;
    if (primitiveStoreLocal(items[i]) === candidate.local || iincLocal(items[i]) === candidate.local) break;
    if (aloadLocal(items[i]) !== candidate.local) continue;
    const reaching = analysis.before[i] && analysis.before[i].get(candidate.local);
    if (!reaching || reaching.size !== 1 || !reaching.has(candidate.defId)) continue;
    if (!seen.has(items[i])) {
      seen.add(items[i]);
      out.push(items[i]);
    }
  }
  return out;
}

function allLoadsTypedForDef(items, analysis, candidate) {
  const expectedLoads = new Set(candidate.loads);
  for (let i = candidate.storeIndex + 1; i < items.length; i += 1) {
    if (astoreLocal(items[i]) === candidate.local) break;
    if (aloadLocal(items[i]) !== candidate.local) continue;
    const reaching = analysis.before[i] && analysis.before[i].get(candidate.local);
    if (!reaching || reaching.size !== 1 || !reaching.has(candidate.defId)) continue;
    if (!expectedLoads.has(items[i])) return false;
  }
  return true;
}

function hasOtherReferenceStore(items, selfIndex, local) {
  for (let i = 0; i < items.length; i += 1) {
    if (i !== selfIndex && astoreLocal(items[i]) === local) return true;
  }
  return false;
}

function hasPrimitiveLocalWriteBeforeLastCandidateLoad(items, storeIndex, local, loads) {
  let lastLoadIndex = -1;
  for (const load of loads || []) {
    lastLoadIndex = Math.max(lastLoadIndex, items.indexOf(load));
  }
  if (lastLoadIndex <= storeIndex) return false;
  for (let i = storeIndex + 1; i < items.length; i += 1) {
    if (astoreLocal(items[i]) === local) return false;
    if (i >= lastLoadIndex) return false;
    if (primitiveStoreLocal(items[i]) === local || iincLocal(items[i]) === local) return true;
  }
  return false;
}

function hasPrimitiveLocalWriteBetween(items, storeIndex, loadIndex, local) {
  if (loadIndex <= storeIndex) return false;
  for (let i = storeIndex + 1; i < loadIndex; i += 1) {
    if (astoreLocal(items[i]) === local) return false;
    if (primitiveStoreLocal(items[i]) === local || iincLocal(items[i]) === local) return true;
  }
  return false;
}

function hasUnrewrittenLoadBeforeNextStore(items, storeIndex, local, rewrittenLoads) {
  for (let i = storeIndex + 1; i < items.length; i += 1) {
    if (astoreLocal(items[i]) === local) return false;
    if (primitiveStoreLocal(items[i]) === local || iincLocal(items[i]) === local) return false;
    if (aloadLocal(items[i]) === local && !rewrittenLoads.includes(items[i])) return true;
  }
  return false;
}

function isBranchTarget(code, item) {
  const label = trimLabel(item && item.labelDef);
  if (!label) return false;
  for (const other of code.codeItems || []) {
    const target = branchTarget(other);
    if (trimLabel(target) === label) return true;
  }
  for (const entry of code.exceptionTable || []) {
    if ([entry.startLbl, entry.endLbl, entry.handlerLbl].some((value) => trimLabel(value) === label)) return true;
  }
  return false;
}

function branchTarget(item) {
  const itemOp = op(item);
  if (!itemOp || (!itemOp.startsWith('if') && itemOp !== 'goto' && itemOp !== 'jsr')) return null;
  return arg(item);
}

function isHandlerStore(exceptionTable, item) {
  const label = trimLabel(item && item.labelDef);
  return !!label && (exceptionTable || []).some((entry) => trimLabel(entry.handlerLbl) === label);
}

function isSimpleStackProducer(item) {
  const itemOp = op(item);
  return itemOp === 'dup' || itemOp === 'dup_x1' || itemOp === 'dup_x2' ||
    itemOp === 'swap' || /^(?:iconst_m1|iconst_[0-5])$/.test(itemOp || '') ||
    itemOp === 'bipush' || itemOp === 'sipush' || itemOp === 'ldc' ||
    /^(?:i|f|d|l)load(?:_[0-3])?$/.test(itemOp || '');
}

function simulateStackEffect(item, stack) {
  const itemOp = op(item);
  const push = (desc) => {
    stack.push(desc || '?');
    return true;
  };
  const pop = (count) => {
    for (let i = 0; i < count; i += 1) {
      if (!stack.length) return false;
      stack.pop();
    }
    return true;
  };

  if (aloadLocal(item) != null) return push('Ljava/lang/Object;');
  if (/^(?:i|f|d|l)load(?:_[0-3])?$/.test(itemOp || '')) return push(primitiveLoadDescriptor(itemOp));
  if (/^(?:aconst_null|iconst_m1|iconst_[0-5]|fconst_[0-2]|dconst_[01]|lconst_[01]|bipush|sipush|ldc)$/.test(itemOp || '')) return push(constantDescriptor(item));
  if (itemOp === 'getfield') {
    if (!pop(1)) return false;
    const ref = arg(item);
    return push(Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : '?');
  }
  if (itemOp === 'getstatic') {
    const ref = arg(item);
    return push(Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : '?');
  }
  if (itemOp === 'aaload') {
    if (!pop(2)) return false;
    return push('Ljava/lang/Object;');
  }
  if (/^[bcdfils]aload$/.test(itemOp || '')) {
    if (!pop(2)) return false;
    return push(arrayLoadDescriptor(itemOp));
  }
  if (/^[bcdfilsa]store$/.test(itemOp || '')) return pop(itemOp === 'lastore' || itemOp === 'dastore' ? 4 : 3);
  if (/^(?:i|f|l|d)(?:add|sub|mul|div|rem|and|or|xor|shl|shr|ushr)$/.test(itemOp || '')) {
    if (!pop(2)) return false;
    return push(arithmeticDescriptor(itemOp));
  }
  if (/^(?:i2[bcdfsl]|f2[dil]|d2[fil]|l2[dfi])$/.test(itemOp || '')) {
    if (!pop(1)) return false;
    return push(conversionDescriptor(itemOp));
  }
  if (itemOp === 'checkcast') return true;
  if (itemOp === 'dup') {
    if (!stack.length) return false;
    stack.push(stack[stack.length - 1]);
    return true;
  }
  if (itemOp === 'dup_x1' || itemOp === 'dup_x2' || itemOp === 'swap') return false;
  return false;
}

function primitiveLoadDescriptor(itemOp) {
  return {
    iload: 'I',
    fload: 'F',
    dload: 'D',
    lload: 'J',
  }[(itemOp || '').replace(/_[0-3]$/, '')] || '?';
}

function constantDescriptor(item) {
  const itemOp = op(item);
  if (itemOp && itemOp.startsWith('fconst_')) return 'F';
  if (itemOp && itemOp.startsWith('dconst_')) return 'D';
  if (itemOp && itemOp.startsWith('lconst_')) return 'J';
  if (itemOp === 'aconst_null') return 'Ljava/lang/Object;';
  if (itemOp === 'ldc') {
    const value = arg(item);
    if (typeof value === 'number') return Number.isInteger(value) ? 'I' : 'F';
  }
  return 'I';
}

function arrayLoadDescriptor(itemOp) {
  return {
    baload: 'B',
    caload: 'C',
    daload: 'D',
    faload: 'F',
    iaload: 'I',
    laload: 'J',
    saload: 'S',
  }[itemOp] || '?';
}

function arithmeticDescriptor(itemOp) {
  if (!itemOp) return '?';
  if (itemOp[0] === 'f') return 'F';
  if (itemOp[0] === 'd') return 'D';
  if (itemOp[0] === 'l') return 'J';
  return 'I';
}

function conversionDescriptor(itemOp) {
  const to = itemOp && itemOp[2];
  return { b: 'B', c: 'C', d: 'D', f: 'F', i: 'I', l: 'J', s: 'S' }[to] || '?';
}

function typesCompatible(produced, expected) {
  if (produced === expected) return true;
  if (expected === '[Ljava/lang/Object;' && /^\[/.test(produced)) return true;
  if (expected === 'Ljava/lang/Object;' && /^L/.test(produced)) return true;
  return false;
}

function primitiveArrayDescriptor(value) {
  return {
    boolean: '[Z',
    byte: '[B',
    char: '[C',
    short: '[S',
    int: '[I',
    long: '[J',
    float: '[F',
    double: '[D',
  }[value] || null;
}

function isPrimitiveArrayDescriptor(desc) {
  return typeof desc === 'string' && /^\[+[ZBCSIJFD]$/.test(desc);
}

function isPrimitiveArrayCandidate(candidate) {
  return isPrimitiveArrayDescriptor(candidate.produced) || isPrimitiveArrayDescriptor(candidate.expected);
}

function isConcreteReferenceArrayCandidate(candidate) {
  return isConcreteReferenceArrayDescriptor(candidate.produced) ||
    isConcreteReferenceArrayDescriptor(candidate.expected);
}

function isConcreteReferenceArrayDescriptor(desc) {
  return typeof desc === 'string' && /^\[+L[^;]+;$/.test(desc) && desc !== '[Ljava/lang/Object;';
}

function arrayElementDescriptor(desc) {
  if (typeof desc !== 'string' || !desc.startsWith('[')) return null;
  return desc.slice(1);
}

function arrayDescriptorFromAnewarray(value) {
  if (typeof value !== 'string') return null;
  return value.startsWith('[') ? `[${value}` : `[L${value};`;
}

function arrayDescriptorFromMultianewarray(value) {
  const desc = Array.isArray(value) ? value[0] : value;
  return typeof desc === 'string' ? desc : null;
}

function referenceDescriptorFromClassName(value) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('[')) return value;
  return `L${value};`;
}

function returnDescriptor(desc) {
  if (typeof desc !== 'string') return null;
  const idx = desc.lastIndexOf(')');
  return idx >= 0 ? desc.slice(idx + 1) : null;
}

function argumentDescriptors(desc) {
  if (typeof desc !== 'string' || desc[0] !== '(') return null;
  const out = [];
  for (let i = 1; i < desc.length && desc[i] !== ')';) {
    let start = i;
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
  if (typeof value === 'string') {
    const match = /^(\d+)\b/.exec(value);
    return match ? match[1] : null;
  }
  return typeof value === 'number' ? String(value) : null;
}

function nextInstructionIndex(items, index) {
  for (let i = index + 1; i < items.length; i += 1) {
    if (items[i] && items[i].instruction) return i;
  }
  return -1;
}

function previousInstructionIndex(items, index) {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (items[i] && items[i].instruction) return i;
  }
  return -1;
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
  runSplitTypedReusedLocals,
  splitCode,
};

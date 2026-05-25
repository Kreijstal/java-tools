'use strict';

const ARRAY_LOADS = new Set(['iaload', 'laload', 'faload', 'daload', 'aaload', 'baload', 'caload', 'saload']);
const ARRAY_STORES = new Set(['iastore', 'lastore', 'fastore', 'dastore', 'aastore', 'bastore', 'castore', 'sastore']);
const RETURN_OPS = new Set(['return', 'ireturn', 'lreturn', 'freturn', 'dreturn', 'areturn']);
const CONDITIONAL_OPS = new Set([
  'ifeq', 'ifne', 'iflt', 'ifge', 'ifgt', 'ifle',
  'if_icmpeq', 'if_icmpne', 'if_icmplt', 'if_icmpge', 'if_icmpgt', 'if_icmple',
  'if_acmpeq', 'if_acmpne', 'ifnull', 'ifnonnull',
]);

function runSplitArrayReachingLocal(astRoot, options = {}) {
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
  const cfg = buildCfg(code);
  if (!cfg.blocks.length) return 0;
  const analysis = reachingDefinitions(code, cfg);
  const requireDominance = !!options.requireDominance;
  const preserveOriginalLocals = !!options.preserveOriginalLocals;
  const dominators = requireDominance ? computeDominators(cfg) : null;
  let candidates = mergeCandidates(
    collectCandidates(code, cfg, analysis, dominators),
    collectPrimitiveArrayLocalCandidates(code, cfg, analysis, dominators),
  );
  if (candidates.length > 2) {
    candidates = candidates.filter((candidate) =>
      candidate.primitiveArray || isSimpleIntArrayCandidate(code, analysis, candidate));
    if (candidates.length > 8) return 0;
  }
  let rewrites = 0;

  for (const candidate of candidates) {
    const fresh = allocateLocal(code);
    candidate.fresh = fresh;
    for (const item of candidate.loadItems) {
      item.instruction = loadRef(fresh);
    }
  }

  for (const candidate of candidates.sort((a, b) => b.storeIndex - a.storeIndex)) {
    const storeIndex = items.indexOf(candidate.storeItem);
    if (storeIndex < 0) continue;
    const preserveOriginal = preserveOriginalLocals && (
      isBranchTarget(code, candidate.storeItem) ||
      hasUnrewrittenLoadBeforeNextStore(items, storeIndex, candidate.local, candidate.loadItems)
    );
    if (preserveOriginal) {
      candidate.storeItem.instruction = storeRef(candidate.fresh);
      items.splice(storeIndex + 1, 0, { instruction: loadRef(candidate.fresh) }, { instruction: storeRef(candidate.local) });
    } else if (candidate.primitiveArray) {
      candidate.storeItem.instruction = storeRef(candidate.fresh);
    } else {
      items.splice(storeIndex, 0, { instruction: 'dup' }, { instruction: storeRef(candidate.fresh) });
      code.stackSize = String(Math.max(Number(code.stackSize || 0), 2));
    }
    rewrites += 1;
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
      if (candidate.arrayUse) existing.arrayUse = true;
      if (candidate.primitiveArray && !existing.arrayUse) existing.primitiveArray = true;
      for (const item of candidate.loadItems || []) {
        if (!existing.loadItems.includes(item)) existing.loadItems.push(item);
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
    if (local == null || !isArrayUse(items, i)) continue;
    const reaching = analysis.before[i] && analysis.before[i].get(local);
    if (!reaching || reaching.size !== 1) continue;
    const [defId] = reaching;
    if (typeof defId !== 'number') continue;
    const def = analysis.defs.get(defId);
    if (!def || def.local !== local) continue;
    if (dominators && !instructionDominates(cfg, dominators, def.index, i)) continue;
    if (isHandlerStore(code.exceptionTable, items[def.index])) continue;
    if (!hasConflictingStore(items, def.index, local)) continue;
    const key = String(defId);
    let candidate = byStore.get(key);
    if (!candidate) {
      candidate = { storeIndex: def.index, storeItem: items[def.index], local, loadItems: [], arrayUse: true };
      byStore.set(key, candidate);
    }
    candidate.loadItems.push(items[i]);
  }
  return [...byStore.values()].filter((candidate) => candidate.loadItems.length > 0);
}

function collectPrimitiveArrayLocalCandidates(code, cfg, analysis, dominators) {
  const byStore = new Map();
  const items = code.codeItems;
  if (items.length > 2000) return [];
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
    if (!hasConflictingStore(items, def.index, local)) continue;
    if (hasPrimitiveLocalWrite(items, local)) continue;
    if (!reachesPrimitiveArrayValue(code, analysis, def.index, new Set())) continue;
    const key = String(defId);
    let candidate = byStore.get(key);
    if (!candidate) {
      candidate = {
        storeIndex: def.index,
        storeItem: items[def.index],
        local,
        loadItems: [],
        primitiveArray: true,
      };
      byStore.set(key, candidate);
    }
    candidate.loadItems.push(items[i]);
  }
  return [...byStore.values()].filter((candidate) => candidate.loadItems.length > 0);
}

function isSimpleIntArrayCandidate(code, analysis, candidate) {
  if (!candidate.loadItems.every((item) => isIntArrayUse(code.codeItems, code.codeItems.indexOf(item)))) return false;
  return reachesIntArrayValue(code, analysis, candidate.storeIndex, new Set());
}

function reachesIntArrayValue(code, analysis, storeIndex, seen) {
  const prev = previousInstructionIndex(code.codeItems, storeIndex);
  if (prev < 0) return false;
  const prevOp = op(code.codeItems[prev]);
  if (prevOp === 'newarray' && arg(code.codeItems[prev]) === 'int') return true;
  const desc = producerDescriptor(code.codeItems[prev]);
  if (desc === '[I') return true;
  const sourceLocal = aloadLocal(code.codeItems[prev]);
  if (sourceLocal == null) return false;
  const key = `${storeIndex}:${sourceLocal}`;
  if (seen.has(key)) return false;
  seen.add(key);
  const reaching = analysis.before[storeIndex] && analysis.before[storeIndex].get(sourceLocal);
  if (!reaching || reaching.size !== 1) return false;
  const [defId] = reaching;
  const def = analysis.defs.get(defId);
  return !!def && reachesIntArrayValue(code, analysis, def.index, seen);
}

function reachesPrimitiveArrayValue(code, analysis, storeIndex, seen) {
  const prev = previousInstructionIndex(code.codeItems, storeIndex);
  if (prev < 0) return false;
  const prevOp = op(code.codeItems[prev]);
  if (prevOp === 'newarray' && isPrimitiveArrayElement(arg(code.codeItems[prev]))) return true;
  const desc = producerDescriptor(code.codeItems[prev]);
  if (isPrimitiveArrayDescriptor(desc)) return true;
  const sourceLocal = aloadLocal(code.codeItems[prev]);
  if (sourceLocal == null) return false;
  const key = `${storeIndex}:${sourceLocal}`;
  if (seen.has(key)) return false;
  seen.add(key);
  const reaching = analysis.before[storeIndex] && analysis.before[storeIndex].get(sourceLocal);
  if (!reaching || reaching.size !== 1) return false;
  const [defId] = reaching;
  const def = analysis.defs.get(defId);
  return !!def && reachesPrimitiveArrayValue(code, analysis, def.index, seen);
}

function isPrimitiveArrayElement(value) {
  return value === 'boolean' || value === 'byte' || value === 'char' || value === 'short' ||
    value === 'int' || value === 'long' || value === 'float' || value === 'double';
}

function isPrimitiveArrayDescriptor(desc) {
  return typeof desc === 'string' && /^\[+[ZBCSIJFD]$/.test(desc);
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

function producerDescriptor(item) {
  const insn = item && item.instruction;
  if (!insn || typeof insn !== 'object') return null;
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

function reachingDefinitions(code, cfg) {
  const items = code.codeItems;
  const defs = new Map();
  const defAt = new Map();
  let nextDef = 1;
  for (let i = 0; i < items.length; i += 1) {
    const local = astoreLocal(items[i]);
    if (local == null) continue;
    const id = nextDef++;
    defs.set(id, { id, index: i, local });
    defAt.set(i, id);
  }

  const inState = new Map();
  const outState = new Map();
  const work = [...cfg.blocks.map((block) => block.id)];
  for (const block of cfg.blocks) {
    inState.set(block.id, new Map());
    outState.set(block.id, new Map());
  }

  while (work.length) {
    const id = work.shift();
    const block = cfg.byId.get(id);
    const merged = mergePredecessors(block, outState);
    const oldIn = inState.get(id);
    const oldOut = outState.get(id);
    const nextOut = transferBlock(block, merged, defAt, defs);
    inState.set(id, merged);
    outState.set(id, nextOut);
    if (!stateEqual(oldIn, merged) || !stateEqual(oldOut, nextOut)) {
      for (const succ of block.successors) {
        if (!work.includes(succ)) work.push(succ);
      }
    }
  }

  const before = new Array(items.length);
  for (const block of cfg.blocks) {
    let state = cloneState(inState.get(block.id));
    for (let idx = block.start; idx <= block.end; idx += 1) {
      before[idx] = cloneState(state);
      const defId = defAt.get(idx);
      if (defId != null) {
        const def = defs.get(defId);
        state.set(def.local, new Set([defId]));
      }
    }
  }

  return { before, defs };
}

function mergePredecessors(block, outState) {
  if (!block.predecessors.length) return new Map();
  let merged = null;
  for (const pred of block.predecessors) {
    const state = outState.get(pred) || new Map();
    if (merged == null) {
      merged = cloneState(state);
    } else {
      unionInto(merged, state);
    }
  }
  return merged || new Map();
}

function transferBlock(block, startState, defAt, defs) {
  const state = cloneState(startState);
  for (let idx = block.start; idx <= block.end; idx += 1) {
    const defId = defAt.get(idx);
    if (defId == null) continue;
    const def = defs.get(defId);
    state.set(def.local, new Set([defId]));
  }
  return state;
}

function buildCfg(code) {
  const items = code.codeItems;
  const labelToIndex = buildLabelIndex(items);
  const leaders = new Set([0]);
  for (let i = 0; i < items.length; i += 1) {
    const itemOp = op(items[i]);
    if (!itemOp) continue;
    for (const target of branchTargets(items[i])) {
      const targetIndex = labelToIndex.get(trimLabel(target));
      if (targetIndex != null) leaders.add(targetIndex);
    }
    if ((isBranch(itemOp) || RETURN_OPS.has(itemOp) || itemOp === 'athrow') && i + 1 < items.length) {
      leaders.add(i + 1);
    }
  }
  for (const entry of code.exceptionTable || []) {
    for (const label of [entry.startLbl, entry.endLbl, entry.handlerLbl]) {
      const idx = labelToIndex.get(trimLabel(label));
      if (idx != null) leaders.add(idx);
    }
  }

  const sorted = [...leaders].filter((idx) => idx >= 0 && idx < items.length).sort((a, b) => a - b);
  const blocks = [];
  const indexToBlock = new Map();
  for (let i = 0; i < sorted.length; i += 1) {
    const start = sorted[i];
    const end = (i + 1 < sorted.length ? sorted[i + 1] : items.length) - 1;
    const block = { id: `b${i}`, start, end, successors: [], predecessors: [] };
    blocks.push(block);
    for (let idx = start; idx <= end; idx += 1) indexToBlock.set(idx, block.id);
  }
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const addEdge = (from, to) => {
    if (!from || !to || from.successors.includes(to.id)) return;
    from.successors.push(to.id);
    to.predecessors.push(from.id);
  };
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    const last = findLastInstructionIndex(items, block.start, block.end);
    if (last < 0) {
      if (blocks[i + 1]) addEdge(block, blocks[i + 1]);
      continue;
    }
    const itemOp = op(items[last]);
    for (const target of branchTargets(items[last])) {
      const targetIndex = labelToIndex.get(trimLabel(target));
      addEdge(block, byId.get(indexToBlock.get(targetIndex)));
    }
    if (!isTerminal(itemOp) && blocks[i + 1]) addEdge(block, blocks[i + 1]);
  }
  for (const entry of code.exceptionTable || []) {
    const start = labelToIndex.get(trimLabel(entry.startLbl));
    const end = labelToIndex.get(trimLabel(entry.endLbl));
    const handler = byId.get(indexToBlock.get(labelToIndex.get(trimLabel(entry.handlerLbl))));
    if (start == null || end == null || !handler) continue;
    for (const block of blocks) {
      if (block.end >= start && block.start < end) addEdge(block, handler);
    }
  }
  return { blocks, byId, indexToBlock };
}

function computeDominators(cfg) {
  const allIds = new Set(cfg.blocks.map((block) => block.id));
  const dom = new Map();
  for (const block of cfg.blocks) {
    dom.set(block.id, block.predecessors.length ? new Set(allIds) : new Set([block.id]));
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const block of cfg.blocks) {
      if (!block.predecessors.length) continue;
      let next = null;
      for (const pred of block.predecessors) {
        const predDom = dom.get(pred) || new Set();
        if (next == null) {
          next = new Set(predDom);
        } else {
          for (const id of [...next]) {
            if (!predDom.has(id)) next.delete(id);
          }
        }
      }
      if (next == null) next = new Set();
      next.add(block.id);
      const old = dom.get(block.id);
      if (!setEqual(old, next)) {
        dom.set(block.id, next);
        changed = true;
      }
    }
  }
  return dom;
}

function instructionDominates(cfg, dominators, defIndex, useIndex) {
  if (defIndex > useIndex) return false;
  const defBlock = cfg.indexToBlock.get(defIndex);
  const useBlock = cfg.indexToBlock.get(useIndex);
  if (!defBlock || !useBlock) return false;
  if (defBlock === useBlock) return defIndex <= useIndex;
  return !!(dominators.get(useBlock) || new Set()).has(defBlock);
}

function setEqual(left, right) {
  if (!left || !right || left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

function isArrayUse(items, index) {
  if (op(items[index + 1]) === 'arraylength') return true;
  for (let i = index + 1; i < Math.min(items.length, index + 8); i += 1) {
    const itemOp = op(items[i]);
    if (ARRAY_LOADS.has(itemOp) || ARRAY_STORES.has(itemOp)) return true;
    if (isBranch(itemOp) || RETURN_OPS.has(itemOp) || itemOp === 'athrow') break;
  }
  return false;
}

function isIntArrayUse(items, index) {
  for (let i = index + 1; i < Math.min(items.length, index + 8); i += 1) {
    const itemOp = op(items[i]);
    if (itemOp === 'iaload' || itemOp === 'iastore') return true;
    if (ARRAY_LOADS.has(itemOp) || ARRAY_STORES.has(itemOp) || itemOp === 'arraylength') return false;
    if (isBranch(itemOp) || RETURN_OPS.has(itemOp) || itemOp === 'athrow') break;
  }
  return false;
}

function hasConflictingStore(items, selfIndex, local) {
  for (let i = 0; i < items.length; i += 1) {
    if (i === selfIndex) continue;
    if (astoreLocal(items[i]) === local) return true;
  }
  return false;
}

function isHandlerStore(exceptionTable, item) {
  const label = trimLabel(item && item.labelDef);
  return !!label && (exceptionTable || []).some((entry) => trimLabel(entry.handlerLbl) === label);
}

function findLastInstructionIndex(items, start, end) {
  for (let i = end; i >= start; i -= 1) {
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

function isTerminal(itemOp) {
  return itemOp === 'goto' || itemOp === 'goto_w' || RETURN_OPS.has(itemOp) || itemOp === 'athrow' ||
    itemOp === 'tableswitch' || itemOp === 'lookupswitch';
}

function isBranch(itemOp) {
  return itemOp === 'goto' || itemOp === 'goto_w' || CONDITIONAL_OPS.has(itemOp) ||
    itemOp === 'tableswitch' || itemOp === 'lookupswitch';
}

function cloneState(state) {
  const out = new Map();
  for (const [key, value] of state || []) out.set(key, new Set(value));
  return out;
}

function unionInto(left, right) {
  for (const [key, value] of right || []) {
    let set = left.get(key);
    if (!set) {
      set = new Set();
      left.set(key, set);
    }
    for (const entry of value) set.add(entry);
  }
}

function stateEqual(a, b) {
  const left = a || new Map();
  const right = b || new Map();
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    const other = right.get(key);
    if (!other || other.size !== value.size) return false;
    for (const entry of value) if (!other.has(entry)) return false;
  }
  return true;
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

function buildLabelIndex(items) {
  const index = new Map();
  items.forEach((item, idx) => {
    if (item && item.labelDef) {
      index.set(trimLabel(item.labelDef), idx);
    }
  });
  return index;
}

module.exports = {
  runSplitArrayReachingLocal,
  splitCode,
  buildCfg,
  computeDominators,
  instructionDominates,
  reachingDefinitions,
};

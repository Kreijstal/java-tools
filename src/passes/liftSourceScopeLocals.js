'use strict';

const CONDITIONAL_OPS = new Set([
  'ifeq', 'ifne', 'iflt', 'ifge', 'ifgt', 'ifle',
  'if_icmpeq', 'if_icmpne', 'if_icmplt', 'if_icmpge', 'if_icmpgt', 'if_icmple',
  'if_acmpeq', 'if_acmpne', 'ifnull', 'ifnonnull',
]);

function runLiftSourceScopeLocals(astRoot) {
  let rewrites = 0;
  for (const cls of astRoot.classes || []) {
    for (const item of cls.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      if (item.method.name === '<init>') continue;
      for (const attr of item.method.attributes || []) {
        const code = attr && attr.type === 'code' && attr.code;
        if (!code || !Array.isArray(code.codeItems)) continue;
        rewrites += rewriteCode(code, item.method);
      }
    }
  }
  return { changed: rewrites > 0, rewrites };
}

function rewriteCode(code, method = {}) {
  const items = code.codeItems;
  if (items.length > 3000) return 0;
  if ((code.exceptionTable || []).length > 0) return 0;
  const argSlots = methodArgSlots(method);
  const labelIndex = buildLabelIndex(items);
  const candidates = collectCandidates(items, labelIndex, argSlots);
  if (candidates.length === 0 || candidates.length > 24) return 0;
  const targets = dispatchTargets(items, labelIndex, candidates);
  if (targets.length < 1 || targets.length > 24) return 0;

  const ordered = candidates.sort((a, b) => Number(a.local) - Number(b.local));
  for (const target of targets.sort((a, b) => b - a)) {
    const label = trimLabel(items[target] && items[target].labelDef);
    if (!label) continue;
    const clones = [];
    for (const candidate of ordered) clones.push(...cloneProducer(candidate));
    clones[0].labelDef = `${label}:`;
    delete items[target].labelDef;
    items.splice(target, 0, ...clones);
  }

  const maxLocal = Math.max(...candidates.map((candidate) => Number(candidate.local)));
  const needed = maxLocal + 1;
  if (Number(code.localsSize || code.locals || 0) < needed) {
    if ('locals' in code) code.locals = String(needed);
    else code.localsSize = String(needed);
  }
  return candidates.length * targets.length;
}

function collectCandidates(items, labelIndex, argSlots) {
  const storesByLocal = new Map();
  const primitiveStores = new Set();
  for (let i = 0; i < items.length; i += 1) {
    const primitive = primitiveStoreLocal(items[i]);
    if (primitive != null) primitiveStores.add(primitive);
    const local = astoreLocal(items[i]);
    if (local == null) continue;
    let stores = storesByLocal.get(local);
    if (!stores) {
      stores = [];
      storesByLocal.set(local, stores);
    }
    stores.push(i);
  }

  const out = [];
  for (const [local, stores] of storesByLocal) {
    if (Number(local) < argSlots) continue;
    if (primitiveStores.has(local)) continue;
    const producer = arrayElementProducer(items, stores[0]) || aliasCopyProducer(items, stores[0]);
    if (!producer) continue;
    if (hasExistingNullInit(items, local, stores[0])) continue;
    const loads = loadIndexes(items, local).filter((idx) => isArrayUseWithin(items, idx, 12));
    if (loads.length < (producer.kind === 'alias' ? 1 : 2)) continue;
    const firstLoad = loads[0];
    if (firstLoad <= stores[0]) continue;
    if (!loads.some((idx) => isArrayUseWithin(items, idx, 6))) continue;
    if (!hasDenseForwardDispatch(items, labelIndex, stores[0], firstLoad)) continue;
    out.push({ local, storeIndex: stores[0], firstLoad, producer: producer.items });
  }
  return out;
}

function dispatchTargets(items, labelIndex, candidates) {
  const minStore = Math.min(...candidates.map((candidate) => candidate.storeIndex));
  const firstLoad = Math.min(...candidates.map((candidate) => candidate.firstLoad));
  const out = new Set();
  const end = Math.min(firstLoad, minStore + 240);
  for (let i = minStore + 1; i < end; i += 1) {
    const itemOp = op(items[i]);
    if (itemOp !== 'goto' && !CONDITIONAL_OPS.has(itemOp)) continue;
    const target = labelIndex.get(trimLabel(arg(items[i])));
    if (target == null || target <= i) continue;
    if (target < firstLoad - 16) continue;
    out.add(target);
  }
  const candidateLocals = new Set(candidates.map((candidate) => String(candidate.local)));
  return [...out].filter((target) => targetUsesCandidate(items, target, candidateLocals));
}

function targetUsesCandidate(items, target, candidateLocals) {
  for (let i = target, seen = 0; i < items.length && seen < 120; i += 1, seen += 1) {
    const itemOp = op(items[i]);
    const local = aloadLocal(items[i]);
    if (local != null && candidateLocals.has(local)) return true;
    if (itemOp === 'goto' || itemOp === 'return' || itemOp === 'areturn' || itemOp === 'ireturn' || itemOp === 'athrow') return false;
  }
  return false;
}

function cloneProducer(candidate) {
  return candidate.producer.map((item) => ({
    instruction: cloneInstruction(item.instruction),
  }));
}

function cloneInstruction(instruction) {
  if (!instruction || typeof instruction === 'string') return instruction;
  if (Array.isArray(instruction)) return instruction.map((entry) => cloneInstruction(entry));
  if (typeof instruction === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(instruction)) out[key] = cloneInstruction(value);
    return out;
  }
  return instruction;
}

function hasDenseForwardDispatch(items, labelIndex, storeIndex, firstLoad) {
  let branches = 0;
  const targets = new Set();
  const end = Math.min(firstLoad, storeIndex + 240);
  for (let i = storeIndex + 1; i < end; i += 1) {
    const itemOp = op(items[i]);
    if (itemOp !== 'goto' && !CONDITIONAL_OPS.has(itemOp)) continue;
    const target = labelIndex.get(trimLabel(arg(items[i])));
    if (target == null || target <= i) continue;
    if (target < firstLoad - 16) continue;
    branches += 1;
    targets.add(target);
  }
  return branches >= 4 && targets.size >= 4;
}

function arrayElementProducer(items, storeIndex) {
  const prev = previousInstructionIndex(items, storeIndex);
  if (prev < 0 || op(items[prev]) !== 'aaload') return null;
  const index = previousInstructionIndex(items, prev);
  const source = previousInstructionIndex(items, index);
  if (index < 0 || source < 0) return null;
  if (!isSmallIntConstant(op(items[index]))) return null;
  if (aloadLocal(items[source]) == null) return null;
  return { kind: 'array-element', items: [items[source], items[index], items[prev], items[storeIndex]] };
}

function aliasCopyProducer(items, storeIndex) {
  const loadIndex = nextInstructionIndex(items, storeIndex);
  const aliasStoreIndex = nextInstructionIndex(items, loadIndex);
  if (loadIndex < 0 || aliasStoreIndex < 0) return null;
  const local = astoreLocal(items[storeIndex]);
  const alias = astoreLocal(items[aliasStoreIndex]);
  if (local == null || alias == null || aloadLocal(items[loadIndex]) !== local) return null;
  return {
    kind: 'alias',
    items: [
      { instruction: loadRef(alias) },
      { instruction: storeRef(local) },
    ],
  };
}

function isSmallIntConstant(itemOp) {
  return /^(?:iconst_m1|iconst_[0-5])$/.test(itemOp || '') ||
    itemOp === 'bipush' || itemOp === 'sipush' || itemOp === 'ldc';
}

function isArrayUseWithin(items, loadIndex, limit) {
  for (let i = nextInstructionIndex(items, loadIndex), seen = 0;
    i >= 0 && seen < limit;
    i = nextInstructionIndex(items, i), seen += 1) {
    const itemOp = op(items[i]);
    if (itemOp === 'arraylength') return true;
    if (itemOp === 'iaload' || itemOp === 'iastore' || itemOp === 'aaload' || itemOp === 'aastore') return true;
    if (!isSimpleStackProducer(itemOp)) return false;
  }
  return false;
}

function isSimpleStackProducer(itemOp) {
  return /^(?:a|i|l|f|d)load(?:_[0-3])?$/.test(itemOp || '') ||
    /^(?:iconst_m1|iconst_[0-5]|aconst_null)$/.test(itemOp || '') ||
    itemOp === 'bipush' || itemOp === 'sipush' || itemOp === 'ldc' ||
    itemOp === 'getstatic' || itemOp === 'getfield' || itemOp === 'aaload' ||
    /^i(?:add|sub|mul|div|rem|and|or|xor|shl|shr|ushr|neg)$/.test(itemOp || '');
}

function hasExistingNullInit(items, local, beforeIndex) {
  for (let i = 0; i < beforeIndex; i += 1) {
    if (astoreLocal(items[i]) !== local) continue;
    const prev = previousInstructionIndex(items, i);
    if (prev >= 0 && op(items[prev]) === 'aconst_null') return true;
  }
  return false;
}

function methodArgSlots(method) {
  const flags = method.accessFlags;
  const isStatic = Array.isArray(flags)
    ? flags.includes('static')
    : (Number(flags) & 0x0008) !== 0;
  let slots = isStatic ? 0 : 1;
  const desc = method.descriptor || '';
  let i = desc.indexOf('(') + 1;
  if (i <= 0) return slots;
  while (i < desc.length && desc[i] !== ')') {
    while (desc[i] === '[') i += 1;
    const ch = desc[i];
    if (ch === 'L') {
      while (i < desc.length && desc[i] !== ';') i += 1;
      i += 1;
      slots += 1;
    } else {
      i += 1;
      slots += ch === 'J' || ch === 'D' ? 2 : 1;
    }
  }
  return slots;
}

function loadIndexes(items, local) {
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    if (aloadLocal(items[i]) === local) out.push(i);
  }
  return out;
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
  runLiftSourceScopeLocals,
  rewriteCode,
};

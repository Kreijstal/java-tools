'use strict';

const {
  buildCfg,
  computeDominators,
  instructionDominates,
} = require('./splitArrayReachingLocal');

function runInitializeUnassignedReferenceLocalsFromParameters(astRoot, options = {}) {
  let rewrites = 0;
  for (const cls of astRoot.classes || []) {
    for (const item of cls.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      for (const attr of item.method.attributes || []) {
        const code = attr && attr.type === 'code' && attr.code;
        if (!code || !Array.isArray(code.codeItems)) continue;
        rewrites += initializeCode(code, item.method, options, cls);
      }
    }
  }
  return { changed: rewrites > 0, rewrites };
}

function initializeCode(code, method = {}, options = {}, cls = null) {
  const items = code.codeItems;
  const params = referenceParameterLocals(method);
  const initializerIndex = method.name === '<init>' ? constructorInitializerEndIndex(items, cls) : 0;
  let cfg = null;
  let dominators = null;
  const dominance = () => {
    if (!cfg) {
      cfg = buildCfg(code);
      dominators = computeDominators(cfg);
    }
    return { cfg, dominators };
  };

  const firstAccess = new Map();
  const hasStore = new Set();
  for (let i = 0; i < items.length; i += 1) {
    const load = aloadLocal(items[i]);
    if (load != null && !firstAccess.has(load)) firstAccess.set(load, { kind: 'load', index: i });
    const store = astoreLocal(items[i]);
    if (store != null) {
      hasStore.add(store);
      if (!firstAccess.has(store)) firstAccess.set(store, { kind: 'store', index: i });
    }
  }

  const paramLocals = new Set(params.map((param) => param.local));
  const initializers = [];
  const maxInitializers = options.maxInitializers || 64;
  for (const [local, access] of firstAccess) {
    if (paramLocals.has(local) || access.kind !== 'load' || !hasStore.has(local)) continue;
    const expected = consumedReferenceDescriptor(items, access.index);
    if (!isReferenceDescriptor(expected)) continue;
    const candidates = params.filter((param) => param.desc === expected);
    if (candidates.length !== 1) continue;
    initializers.push({ local, source: candidates[0].local });
  }
  for (const [local, access] of firstAccess) {
    if (paramLocals.has(local) || access.kind !== 'store' || !hasLaterLoad(items, access.index, local)) continue;
    if (access.index <= initializerIndex) continue;
    const producerIndex = previousInstructionIndex(items, access.index);
    if (op(items[producerIndex]) !== 'checkcast') continue;
    const desc = producerDescriptor(items, producerIndex);
    if (!isObjectDescriptor(desc) || desc === 'Ljava/lang/Throwable;' ||
        desc === 'Ljava/lang/Exception;' || desc === 'Ljava/lang/Object;') continue;
    if (Number(local) < (options.minNullInitLocal || 16)) {
      const dom = dominance();
      if (!hasLaterMatchingLoadNotDominatedByStore(items, dom.cfg, dom.dominators, access.index, local, desc)) continue;
    }
    initializers.push({ local, source: null });
  }

  if (initializers.length === 0 || initializers.length > maxInitializers) return 0;
  const initItems = [];
  for (const init of initializers) {
    initItems.push({ instruction: init.source == null ? 'aconst_null' : loadRef(init.source) });
    initItems.push({ instruction: storeRef(init.local) });
  }
  items.splice(initializerIndex, 0, ...initItems);
  const maxLocal = Math.max(...initializers.flatMap((init) => [Number(init.local), Number(init.source)]).filter(Number.isFinite));
  if (Number.isInteger(maxLocal) && (Number(code.localsSize) || 0) <= maxLocal) {
    code.localsSize = maxLocal + 1;
  }
  return initializers.length;
}

function constructorInitializerEndIndex(items, cls = null) {
  for (let i = 0; i < items.length; i += 1) {
    if (op(items[i]) !== 'invokespecial') continue;
    const ref = arg(items[i]);
    const name = Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][0] : null;
    if (name !== '<init>') continue;
    if (cls && ref[1] !== cls.className && ref[1] !== cls.superClassName) continue;
    return i + 1;
  }
  return 0;
}

function hasLaterLoad(items, startIndex, local) {
  for (let i = startIndex + 1; i < items.length; i += 1) {
    if (aloadLocal(items[i]) === local) return true;
  }
  return false;
}

function hasLaterMatchingLoadNotDominatedByStore(items, cfg, dominators, storeIndex, local, desc) {
  for (let i = storeIndex + 1; i < items.length; i += 1) {
    if (aloadLocal(items[i]) !== local) continue;
    if (instructionDominates(cfg, dominators, storeIndex, i)) continue;
    const expected = consumedReferenceDescriptor(items, i);
    if (expected === desc) return true;
  }
  return false;
}

function producerDescriptor(items, index) {
  if (index < 0) return null;
  const itemOp = op(items[index]);
  if (itemOp === 'checkcast') return referenceDescriptorFromClassName(arg(items[index]));
  if (itemOp === 'new') return referenceDescriptorFromClassName(arg(items[index]));
  if (itemOp === 'anewarray') return arrayDescriptorFromClassName(arg(items[index]));
  if (itemOp === 'getfield' || itemOp === 'getstatic') return fieldDescriptor(arg(items[index]));
  if (/^invoke/.test(itemOp || '')) return returnDescriptor(methodDescriptor(arg(items[index])));
  return null;
}

function consumedReferenceDescriptor(items, loadIndex) {
  const next = nextInstructionIndex(items, loadIndex);
  if (next < 0) return null;
  const itemOp = op(items[next]);
  if (itemOp === 'getfield') return fieldOwnerDescriptor(arg(items[next]));
  if (/^invoke/.test(itemOp || '')) {
    const params = parameterDescriptors(methodDescriptor(arg(items[next])));
    return params && params.length > 0 ? params[params.length - 1] : null;
  }
  if (itemOp === 'checkcast') return referenceDescriptorFromClassName(arg(items[next]));
  if (itemOp === 'areturn') return null;
  return null;
}

function fieldOwnerDescriptor(ref) {
  return Array.isArray(ref) && typeof ref[1] === 'string' ? referenceDescriptorFromClassName(ref[1]) : null;
}

function referenceParameterLocals(method) {
  const out = [];
  let slot = method.flags && method.flags.includes('static') ? 0 : 1;
  for (const desc of parameterDescriptors(method.descriptor) || []) {
    if (isReferenceDescriptor(desc)) out.push({ local: String(slot), desc });
    slot += desc === 'J' || desc === 'D' ? 2 : 1;
  }
  return out;
}

function parameterDescriptors(desc) {
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

function methodDescriptor(ref) {
  return Array.isArray(ref) && Array.isArray(ref[2]) && typeof ref[2][1] === 'string' ? ref[2][1] : null;
}

function isReferenceDescriptor(desc) {
  return typeof desc === 'string' && (desc.startsWith('L') || desc.startsWith('['));
}

function isObjectDescriptor(desc) {
  return typeof desc === 'string' && desc.startsWith('L');
}

function referenceDescriptorFromClassName(value) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('[')) return value;
  return `L${value};`;
}

function arrayDescriptorFromClassName(value) {
  return typeof value === 'string' && !value.startsWith('[') ? `[L${value};` : value;
}

function fieldDescriptor(ref) {
  return Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
}

function returnDescriptor(desc) {
  if (typeof desc !== 'string') return null;
  const idx = desc.lastIndexOf(')');
  return idx >= 0 ? desc.slice(idx + 1) : null;
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

function op(item) {
  const insn = item && item.instruction;
  return typeof insn === 'string' ? insn : insn && insn.op;
}

function arg(item) {
  const insn = item && item.instruction;
  return insn && typeof insn === 'object' ? insn.arg : null;
}

module.exports = {
  runInitializeUnassignedReferenceLocalsFromParameters,
  initializeCode,
};

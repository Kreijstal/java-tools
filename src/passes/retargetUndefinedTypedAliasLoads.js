'use strict';

const {
  buildCfg,
  computeDominators,
  instructionDominates,
  reachingDefinitions,
} = require('./splitArrayReachingLocal');

function runRetargetUndefinedTypedAliasLoads(astRoot, options = {}) {
  let rewrites = 0;
  for (const cls of astRoot.classes || []) {
    for (const item of cls.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      for (const attr of item.method.attributes || []) {
        const code = attr && attr.type === 'code' && attr.code;
        if (!code || !Array.isArray(code.codeItems)) continue;
        rewrites += rewriteCode(code, item.method, options);
      }
    }
  }
  return { changed: rewrites > 0, rewrites };
}

function rewriteCode(code, methodOrOptions = {}, maybeOptions = {}) {
  const method = methodOrOptions && methodOrOptions.descriptor ? methodOrOptions : null;
  const options = method ? maybeOptions : methodOrOptions;
  const items = code.codeItems;
  if (items.length > (options.maxMethodItems || 10000)) return 0;
  const cfg = buildCfg(code);
  if (!cfg.blocks.length) return 0;
  const analysis = reachingDefinitions(code, cfg);
  const dominators = computeDominators(cfg);
  const replacements = [];

  for (let i = 0; i < items.length; i += 1) {
    const stale = aloadLocal(items[i]);
    if (stale == null || hasDominatingDefinition(cfg, dominators, analysis, i, stale)) continue;
    const owner = fieldOwnerAtUse(items, i);
    const isAliasCopy = owner == null && astoreLocal(items[nextInstructionIndex(items, i)]) != null;
    if (!owner && !isAliasCopy) {
      const parameterSource = method ? findCompatibleArrayParameter(items, i, method) : null;
      if (!parameterSource) continue;
      replacements.push({ start: i, stale, fresh: parameterSource.fresh, singleUse: true });
      continue;
    }
    const source = findRecentCheckedAlias(items, i, owner, stale);
    if (source) {
      replacements.push({ start: i, stale, fresh: source.fresh, owner, aliasCopyOnly: isAliasCopy });
      continue;
    }
    const parameterSource = method ? findCompatibleArrayParameter(items, i, method) : null;
    if (!parameterSource) continue;
    replacements.push({ start: i, stale, fresh: parameterSource.fresh, singleUse: true });
  }

  let rewrites = 0;
  for (const replacement of replacements) {
    for (let i = replacement.start; i < items.length; i += 1) {
      if (astoreLocal(items[i]) === replacement.stale) break;
      if (aloadLocal(items[i]) !== replacement.stale) continue;
      if (hasDominatingDefinition(cfg, dominators, analysis, i, replacement.stale)) continue;
      if (replacement.singleUse && i !== replacement.start) break;
      if (replacement.aliasCopyOnly && i !== replacement.start) break;
      if (replacement.singleUse) {
        // Already constrained to exactly the one undefined load.
      } else if (replacement.aliasCopyOnly) {
        if (astoreLocal(items[nextInstructionIndex(items, i)]) == null) continue;
      } else if (fieldOwnerAtUse(items, i) !== replacement.owner) {
        continue;
      }
      items[i].instruction = loadRef(replacement.fresh);
      rewrites += 1;
    }
  }
  return rewrites;
}

function findCompatibleArrayParameter(items, loadIndex, method) {
  const expected = expectedArrayDescriptorAtUse(items, loadIndex);
  if (!expected) return null;
  const candidates = parameterLocals(method)
    .filter((param) => arrayDescriptorCompatible(param.descriptor, expected));
  return candidates.length === 1 ? { fresh: candidates[0].local } : null;
}

function expectedArrayDescriptorAtUse(items, loadIndex) {
  for (let i = nextInstructionIndex(items, loadIndex), seen = 0; i >= 0 && seen < 8; i = nextInstructionIndex(items, i), seen += 1) {
    const itemOp = op(items[i]);
    if (itemOp === 'faload' || itemOp === 'fastore') return '[F';
    if (itemOp === 'daload' || itemOp === 'dastore') return '[D';
    if (itemOp === 'laload' || itemOp === 'lastore') return '[J';
    if (itemOp === 'iaload' || itemOp === 'iastore') return '[I';
    if (itemOp === 'baload' || itemOp === 'bastore') return '[B';
    if (itemOp === 'caload' || itemOp === 'castore') return '[C';
    if (itemOp === 'saload' || itemOp === 'sastore') return '[S';
    if (itemOp === 'aaload') return '[[*';
    if (itemOp === 'aastore') return '[L*';
    if (itemOp === 'arraylength') return '[*';
    if (!isSimpleStackProducer(items[i])) return null;
  }
  return null;
}

function arrayDescriptorCompatible(actual, expected) {
  if (actual === expected) return true;
  if (expected === '[*') return typeof actual === 'string' && actual.startsWith('[');
  if (expected === '[[*') return typeof actual === 'string' && (
    actual.startsWith('[[') || actual.startsWith('[L'));
  if (expected === '[L*') return typeof actual === 'string' && actual.startsWith('[L');
  return false;
}

function parameterLocals(method) {
  const descriptors = argumentDescriptors(method.descriptor);
  if (!descriptors) return [];
  const out = [];
  let local = method.flags && method.flags.includes('static') ? 0 : 1;
  for (const descriptor of descriptors) {
    out.push({ local: String(local), descriptor });
    local += descriptor === 'J' || descriptor === 'D' ? 2 : 1;
  }
  return out;
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

function isSimpleStackProducer(item) {
  const itemOp = op(item);
  return itemOp === 'iconst_m1' || itemOp === 'iconst_0' || itemOp === 'iconst_1' ||
    itemOp === 'iconst_2' || itemOp === 'iconst_3' || itemOp === 'iconst_4' ||
    itemOp === 'iconst_5' || itemOp === 'bipush' || itemOp === 'sipush' ||
    /^(?:i|f|d|l)load(?:_[0-3])?$/.test(itemOp || '') ||
    /^(?:i|f|d|l)load$/.test(itemOp || '');
}

function findRecentCheckedAlias(items, loadIndex, owner, stale) {
  for (let i = previousInstructionIndex(items, loadIndex), seen = 0; i >= 0 && seen < 12; i = previousInstructionIndex(items, i), seen += 1) {
    const fresh = astoreLocal(items[i]);
    if (fresh == null || fresh === stale) continue;
    const prev = previousInstructionIndex(items, i);
    if (op(items[prev]) === 'checkcast' && (owner == null || arg(items[prev]) === owner)) return { fresh };
  }
  return null;
}

function fieldOwnerAtUse(items, loadIndex) {
  const useIndex = nextInstructionIndex(items, loadIndex);
  if (useIndex < 0 || op(items[useIndex]) !== 'getfield') return null;
  const ref = arg(items[useIndex]);
  return Array.isArray(ref) && typeof ref[1] === 'string' ? ref[1] : null;
}

function hasDominatingDefinition(cfg, dominators, analysis, index, local) {
  const reaching = analysis.before[index] && analysis.before[index].get(String(local));
  if (!reaching || reaching.size === 0) return false;
  for (const defId of reaching) {
    const def = analysis.defs.get(defId);
    if (!def || !instructionDominates(cfg, dominators, def.index, index)) return false;
  }
  return true;
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

function loadRef(local) {
  const n = Number(local);
  if (Number.isInteger(n) && n >= 0 && n <= 3) return `aload_${n}`;
  return { op: 'aload', arg: String(local) };
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
  runRetargetUndefinedTypedAliasLoads,
  rewriteCode,
};

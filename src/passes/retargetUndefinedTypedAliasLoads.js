'use strict';

const {
  buildCfg,
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
        rewrites += rewriteCode(code, options);
      }
    }
  }
  return { changed: rewrites > 0, rewrites };
}

function rewriteCode(code, options = {}) {
  const items = code.codeItems;
  if (items.length > (options.maxMethodItems || 10000)) return 0;
  const cfg = buildCfg(code);
  if (!cfg.blocks.length) return 0;
  const analysis = reachingDefinitions(code, cfg);
  const replacements = [];

  for (let i = 0; i < items.length; i += 1) {
    const stale = aloadLocal(items[i]);
    if (stale == null || hasReachingDefinition(analysis, i, stale)) continue;
    const owner = fieldOwnerAtUse(items, i);
    const isAliasCopy = owner == null && astoreLocal(items[nextInstructionIndex(items, i)]) != null;
    if (!owner && !isAliasCopy) continue;
    const source = findRecentCheckedAlias(items, i, owner, stale);
    if (!source) continue;
    replacements.push({ start: i, stale, fresh: source.fresh, owner, aliasCopyOnly: isAliasCopy });
  }

  let rewrites = 0;
  for (const replacement of replacements) {
    for (let i = replacement.start; i < items.length; i += 1) {
      if (astoreLocal(items[i]) === replacement.stale) break;
      if (aloadLocal(items[i]) !== replacement.stale) continue;
      if (hasReachingDefinition(analysis, i, replacement.stale)) continue;
      if (replacement.aliasCopyOnly && i !== replacement.start) break;
      if (replacement.aliasCopyOnly) {
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

function hasReachingDefinition(analysis, index, local) {
  const reaching = analysis.before[index] && analysis.before[index].get(String(local));
  return !!reaching && reaching.size > 0;
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

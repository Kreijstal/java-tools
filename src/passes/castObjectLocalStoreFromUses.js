'use strict';

const { buildCfg, reachingDefinitions } = require('./splitArrayReachingLocal');

function runCastObjectLocalStoreFromUses(astRoot) {
  let rewrites = 0;
  for (const cls of astRoot.classes || []) {
    for (const item of cls.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      for (const attr of item.method.attributes || []) {
        const code = attr && attr.type === 'code' && attr.code;
        if (!code || !Array.isArray(code.codeItems)) continue;
        rewrites += rewriteCode(code);
      }
    }
  }
  return { changed: rewrites > 0, rewrites };
}

function rewriteCode(code) {
  const items = code.codeItems;
  if (items.length > 10000) return 0;
  const cfg = buildCfg(code);
  if (!cfg.blocks.length) return 0;
  const analysis = reachingDefinitions(code, cfg);
  const byDef = collectLoadUses(code, analysis);
  const insertions = [];
  for (const [defId, loadIndexes] of byDef) {
    const def = analysis.defs.get(defId);
    if (!def || isHandlerStore(code.exceptionTable, items[def.index])) continue;
    if (countReferenceStores(items, def.local) < 3) continue;
    if (isReturnedLocal(items, def.local)) continue;
    if (previousOp(items, def.index) === 'checkcast') continue;
    const desc = impliedDescriptor(items, loadIndexes);
    if (!isConcreteObjectDescriptor(desc)) continue;
    insertions.push({ index: def.index, desc });
  }
  for (const insertion of insertions.sort((a, b) => b.index - a.index)) {
    items.splice(insertion.index, 0, { instruction: { op: 'checkcast', arg: descriptorClassName(insertion.desc) } });
  }
  return insertions.length;
}

function isReturnedLocal(items, local) {
  for (let i = 0; i < items.length; i += 1) {
    if (aloadLocal(items[i]) === String(local) && op(items[nextInstructionIndex(items, i)]) === 'areturn') {
      return true;
    }
  }
  return false;
}

function countReferenceStores(items, local) {
  let count = 0;
  for (const item of items) {
    if (astoreLocal(item) === String(local)) count += 1;
  }
  return count;
}

function collectLoadUses(code, analysis) {
  const byDef = new Map();
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
    let list = byDef.get(defId);
    if (!list) {
      list = [];
      byDef.set(defId, list);
    }
    list.push(i);
  }
  return byDef;
}

function impliedDescriptor(items, loadIndexes) {
  let desc = null;
  let typedUses = 0;
  for (const loadIndex of loadIndexes) {
    const useDesc = impliedDescriptorAtUse(items, loadIndex);
    if (!useDesc) continue;
    if (desc && desc !== useDesc) return null;
    desc = useDesc;
    typedUses += 1;
  }
  return typedUses > 0 ? desc : null;
}

function impliedDescriptorAtUse(items, loadIndex) {
  const useIndex = nextInstructionIndex(items, loadIndex);
  if (useIndex < 0) return null;
  const itemOp = op(items[useIndex]);
  if (itemOp === 'getfield') {
    const ref = arg(items[useIndex]);
    return Array.isArray(ref) ? `L${ref[1]};` : null;
  }
  if (itemOp === 'putfield' || itemOp === 'putstatic') {
    const ref = arg(items[useIndex]);
    return Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
  }
  if (itemOp === 'aastore') return impliedDescriptorFromArrayStoreValue(items, loadIndex);
  if (itemOp === 'ifnull' || itemOp === 'ifnonnull' || itemOp === 'if_acmpeq' || itemOp === 'if_acmpne') {
    return null;
  }
  return null;
}

function impliedDescriptorFromArrayStoreValue(items, loadIndex) {
  const indexProducer = previousInstructionIndex(items, loadIndex);
  if (indexProducer < 0) return null;
  const arrayProducer = previousInstructionIndex(items, indexProducer);
  if (arrayProducer < 0) return null;
  const desc = arrayDescriptorAt(items[arrayProducer]);
  if (typeof desc !== 'string' || !desc.startsWith('[L')) return null;
  return desc.slice(1);
}

function arrayDescriptorAt(item) {
  const itemOp = op(item);
  if (itemOp === 'getfield' || itemOp === 'getstatic') {
    const ref = arg(item);
    return Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
  }
  return null;
}

function isConcreteObjectDescriptor(desc) {
  return typeof desc === 'string' && /^L[^;]+;$/.test(desc) &&
    desc !== 'Ljava/lang/Object;' && desc !== 'Ljava/lang/Throwable;' && desc !== 'Ljava/lang/Exception;';
}

function descriptorClassName(desc) {
  return desc.slice(1, -1);
}

function isHandlerStore(exceptionTable, item) {
  const label = trimLabel(item && item.labelDef);
  return !!label && (exceptionTable || []).some((entry) => trimLabel(entry.handlerLbl) === label);
}

function previousOp(items, index) {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (items[i] && items[i].instruction) return op(items[i]);
  }
  return null;
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
  runCastObjectLocalStoreFromUses,
  rewriteCode,
};

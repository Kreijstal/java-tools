'use strict';

function runSplitPrimitiveIntBranchLocal(astRoot) {
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
  if (items.length > 10000) return 0;
  let candidates = collectCandidates(code);
  if (candidates.length > 4) {
    candidates = candidates.filter((candidate) => candidate.backGoto - candidate.storeIndex <= 80);
  }
  if (candidates.length > 4) return 0;

  for (const candidate of candidates) {
    candidate.fresh = allocateLocal(code);
    candidate.storeItem.instruction = storeInt(candidate.fresh);
    for (const item of candidate.loadItems) item.instruction = loadInt(candidate.fresh);
    for (const item of candidate.iincItems) rewriteIincLocal(item, candidate.fresh);
  }
  for (const candidate of candidates.sort((a, b) => b.storeIndex - a.storeIndex)) {
    items.splice(candidate.storeIndex + 1, 0,
      { instruction: loadInt(candidate.fresh) },
      { instruction: storeInt(candidate.local) });
  }
  return candidates.length;
}

function collectCandidates(code) {
  const items = code.codeItems;
  const labels = labelIndexes(items);
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    const local = istoreLocal(items[i]);
    if (local == null) continue;
    if (countIntStores(items, local) !== 2) continue;
    if (!hasPriorIntStore(items, i, local)) continue;
    if (!isIntProducer(items, previousInstructionIndex(items, i))) continue;

    const backGoto = firstBackwardGotoAfter(items, labels, i + 1);
    if (backGoto < 0) continue;
    const target = labels.get(trimLabel(arg(items[backGoto])));
    if (target == null || target <= i) continue;
    const nextWrite = nextIntWrite(items, i + 1, local);
    if (nextWrite >= 0 && nextWrite <= backGoto) continue;
    if (hasBypassIntoRange(items, labels, i, backGoto)) continue;

    const loadItems = [];
    const iincItems = [];
    let arrayIndexUse = false;
    for (let j = i + 1; j < backGoto; j += 1) {
      if (istoreLocal(items[j]) === local) break;
      if (iloadLocal(items[j]) === local) {
        loadItems.push(items[j]);
        if (isArrayIndexUse(items, j)) arrayIndexUse = true;
      }
      if (iincLocal(items[j]) === local) iincItems.push(items[j]);
    }
    if (loadItems.length < 2 || iincItems.length === 0 || !arrayIndexUse) continue;
    if (hasLaterUseBeforeWrite(items, backGoto + 1, local)) continue;
    out.push({ storeIndex: i, storeItem: items[i], local, loadItems, iincItems, backGoto });
  }
  return out;
}

function hasBypassIntoRange(items, labels, storeIndex, endIndex) {
  for (let i = 0; i < storeIndex; i += 1) {
    for (const label of branchTargetLabels(items[i])) {
      const target = labels.get(trimLabel(label));
      if (target != null && target > storeIndex && target <= endIndex) return true;
    }
  }
  return false;
}

function branchTargetLabels(item) {
  const itemOp = op(item);
  if (!/^(?:if|goto|jsr|lookupswitch|tableswitch)/.test(itemOp || '')) return [];
  const labels = [];
  collectLabels(arg(item), labels);
  return labels;
}

function collectLabels(value, out) {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectLabels(item, out);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const key of ['label', 'target', 'default', 'defaultLabel', 'labels', 'targets']) {
    if (value[key] != null) collectLabels(value[key], out);
  }
}

function isArrayIndexUse(items, loadIndex) {
  for (let i = nextInstructionIndex(items, loadIndex), seen = 0;
    i >= 0 && seen < 5;
    i = nextInstructionIndex(items, i), seen += 1) {
    const itemOp = op(items[i]);
    if (/^(?:i|l|f|d|a|b|c|s)aload$/.test(itemOp || '') ||
        /^(?:i|l|f|d|a|b|c|s)astore$/.test(itemOp || '')) {
      return true;
    }
    if (!isSimpleIntStackOp(items[i])) return false;
  }
  return false;
}

function hasLaterUseBeforeWrite(items, start, local) {
  for (let i = start; i < items.length; i += 1) {
    if (istoreLocal(items[i]) === local) return false;
    if (iloadLocal(items[i]) === local || iincLocal(items[i]) === local) return true;
  }
  return false;
}

function firstBackwardGotoAfter(items, labels, start) {
  for (let i = start; i < items.length; i += 1) {
    if (op(items[i]) !== 'goto') continue;
    const target = labels.get(trimLabel(arg(items[i])));
    if (target != null && target < i && target >= start) return i;
  }
  return -1;
}

function hasPriorIntStore(items, before, local) {
  for (let i = before - 1; i >= 0; i -= 1) {
    if (istoreLocal(items[i]) === local) return true;
  }
  return false;
}

function countIntStores(items, local) {
  let count = 0;
  for (const item of items) {
    if (istoreLocal(item) === local) count += 1;
  }
  return count;
}

function nextIntWrite(items, start, local) {
  for (let i = start; i < items.length; i += 1) {
    if (istoreLocal(items[i]) === local) return i;
  }
  return -1;
}

function isIntProducer(items, index) {
  if (index < 0) return false;
  const itemOp = op(items[index]);
  return /^(?:iconst_m1|iconst_[0-5]|bipush|sipush|ldc|iload|iload_[0-3]|iaload|getfield|getstatic|iadd|isub|imul|idiv|irem|ishl|ishr|iushr|iand|ior|ixor|invoke.*)$/.test(itemOp || '');
}

function isSimpleIntStackOp(item) {
  const itemOp = op(item);
  return /^(?:iconst_m1|iconst_[0-5]|bipush|sipush|ldc|iload|iload_[0-3]|aload|aload_[0-3]|getfield|getstatic|iadd|isub|imul|idiv|irem|ishl|ishr|iushr|iand|ior|ixor)$/.test(itemOp || '');
}

function labelIndexes(items) {
  const out = new Map();
  for (let i = 0; i < items.length; i += 1) {
    const label = trimLabel(items[i] && items[i].labelDef);
    if (label) out.set(label, i);
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

function loadInt(local) {
  const n = Number(local);
  if (Number.isInteger(n) && n >= 0 && n <= 3) return `iload_${n}`;
  return { op: 'iload', arg: String(local) };
}

function storeInt(local) {
  const n = Number(local);
  if (Number.isInteger(n) && n >= 0 && n <= 3) return `istore_${n}`;
  return { op: 'istore', arg: String(local) };
}

function rewriteIincLocal(item, local) {
  const insn = item && item.instruction;
  if (!insn || typeof insn !== 'object') return;
  if (Array.isArray(insn.arg)) insn.arg[0] = String(local);
  else if (insn.arg && typeof insn.arg === 'object') insn.arg.local = String(local);
  else if (typeof insn.arg === 'string') insn.arg = `${local} ${insn.arg.split(/\s+/).slice(1).join(' ')}`;
  else insn.varnum = String(local);
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

function iloadLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'iload') return String(arg(item));
  const match = /^iload_([0-3])$/.exec(itemOp || '');
  return match ? match[1] : null;
}

function istoreLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'istore') return String(arg(item));
  const match = /^istore_([0-3])$/.exec(itemOp || '');
  return match ? match[1] : null;
}

function iincLocal(item) {
  if (op(item) !== 'iinc') return null;
  const insn = item && item.instruction;
  if (!insn || typeof insn !== 'object') return null;
  if (Array.isArray(insn.arg)) return String(insn.arg[0]);
  if (insn.arg && typeof insn.arg === 'object' && insn.arg.local != null) return String(insn.arg.local);
  if (typeof insn.arg === 'string') return insn.arg.split(/\s+/)[0];
  if (insn.varnum != null) return String(insn.varnum);
  return null;
}

function op(item) {
  const insn = item && item.instruction;
  return typeof insn === 'string' ? insn : insn && insn.op;
}

function arg(item) {
  const insn = item && item.instruction;
  if (!insn || typeof insn !== 'object') return null;
  return insn.arg != null ? insn.arg : insn.varnum;
}

function trimLabel(label) {
  return typeof label === 'string' ? label.replace(/:$/, '') : null;
}

module.exports = {
  runSplitPrimitiveIntBranchLocal,
  splitCode,
  collectCandidates,
};

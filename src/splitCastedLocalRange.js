'use strict';

function runSplitCastedLocalRange(astRoot) {
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
  const labels = buildLabelIndex(items);
  const candidates = [];
  for (let i = 1; i < items.length; i += 1) {
    if (op(items[i - 1]) !== 'checkcast') continue;
    if (!returnsClass(items[i - 2], 'bh')) continue;
    const target = arg(items[i - 1]);
    if (!isConcreteClass(target)) continue;
    const local = astoreLocal(items[i]);
    if (local == null) continue;
    const nextStore = findNextStore(items, i + 1, local);
    if (nextStore < 0) continue;
    if (nextStore - i > 32) continue;
    const loads = collectLoads(items, i + 1, nextStore, local);
    if (!loads.length) continue;
    if (hasBackwardBranchIntoRange(items, labels, i + 1, nextStore, i)) continue;
    candidates.push({ storeIndex: i, storeItem: items[i], local, loads: loads.map((idx) => items[idx]) });
  }

  for (const candidate of candidates) {
    const fresh = allocateLocal(code);
    candidate.fresh = fresh;
    for (const item of candidate.loads) item.instruction = loadRef(fresh);
  }

  let rewrites = 0;
  for (const candidate of candidates.sort((a, b) => b.storeIndex - a.storeIndex)) {
    const idx = items.indexOf(candidate.storeItem);
    if (idx < 0) continue;
    items.splice(idx, 0, { instruction: 'dup' }, { instruction: storeRef(candidate.fresh) });
    code.stackSize = String(Math.max(Number(code.stackSize || 0), 2));
    rewrites += 1;
  }
  return rewrites;
}

function buildLabelIndex(items) {
  const labels = new Map();
  for (let i = 0; i < items.length; i += 1) {
    const label = items[i] && items[i].labelDef;
    if (typeof label === 'string') labels.set(label.replace(/:$/, ''), i);
  }
  return labels;
}

function hasBackwardBranchIntoRange(items, labels, start, end, storeIndex) {
  for (let i = start; i < end; i += 1) {
    const target = branchTarget(items[i]);
    if (!target) continue;
    const targetIndex = labels.get(target.replace(/:$/, ''));
    if (targetIndex != null && targetIndex < storeIndex) return true;
  }
  return false;
}

function branchTarget(item) {
  const itemOp = op(item);
  if (!itemOp || !isBranch(itemOp)) return null;
  const target = arg(item);
  return typeof target === 'string' ? target : null;
}

function isBranch(itemOp) {
  return itemOp === 'goto' || /^if/.test(itemOp);
}

function returnsClass(item, className) {
  const insn = item && item.instruction;
  if (!insn || typeof insn !== 'object') return false;
  if (!/^invoke/.test(insn.op || '')) return false;
  const ref = insn.arg;
  const desc = Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
  return typeof desc === 'string' && desc.endsWith(`)L${className};`);
}

function collectLoads(items, start, end, local) {
  const loads = [];
  for (let i = start; i < end; i += 1) {
    if (aloadLocal(items[i]) === local) loads.push(i);
  }
  return loads;
}

function findNextStore(items, start, local) {
  for (let i = start; i < items.length; i += 1) {
    if (astoreLocal(items[i]) === local) return i;
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

function isConcreteClass(target) {
  return typeof target === 'string' && target !== 'java/lang/Object' && !target.startsWith('[');
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

module.exports = {
  runSplitCastedLocalRange,
  rewriteCode,
};

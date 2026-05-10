'use strict';

const TERMINALS = new Set(['return', 'ireturn', 'lreturn', 'freturn', 'dreturn', 'areturn', 'athrow']);

function runControlFlowDce(astRoot) {
  let rewrites = 0;
  for (const cls of astRoot.classes || []) {
    for (const item of cls.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      for (const attr of item.method.attributes || []) {
        const code = attr && attr.type === 'code' && attr.code;
        if (!code || !Array.isArray(code.codeItems)) continue;
        rewrites += mergeAdjacentConstReturns(code);
        rewrites += collapseGotoChains(code);
        rewrites += inlineGotoConstReturns(code);
        rewrites += mergeAdjacentConstReturns(code);
        rewrites += shareConstReturnGotos(code);
        rewrites += removeUnreferencedAfterTerminals(code);
      }
    }
  }
  return { changed: rewrites > 0, rewrites };
}

function shareConstReturnGotos(code) {
  const items = code.codeItems;
  const labels = buildLabelIndex(items);
  let rewrites = 0;
  for (let i = 0; i < items.length; i += 1) {
    if (op(items[i]) !== 'goto') continue;
    const targetIndex = labels.get(trimLabel(arg(items[i])));
    if (targetIndex == null) continue;
    const targetConst = nextInstructionIndex(items, targetIndex - 1);
    const targetReturn = nextInstructionIndex(items, targetConst);
    const nearbyConst = nextInstructionIndex(items, i);
    const nearbyReturn = nextInstructionIndex(items, nearbyConst);
    if (targetConst < 0 || targetReturn < 0 || nearbyConst < 0 || nearbyReturn < 0) continue;
    if (!isConstOp(op(items[targetConst])) || !isConstOp(op(items[nearbyConst]))) continue;
    if (!isReturnOp(op(items[targetReturn])) || op(items[targetReturn]) !== op(items[nearbyReturn])) continue;
    if (targetConst <= nearbyReturn) continue;
    const sharedLabel = ensureLabel(items, nearbyReturn, 'Lshared_return');
    items[i].instruction = cloneInstruction(items[targetConst].instruction);
    items.splice(i + 1, 0, { instruction: { op: 'goto', arg: sharedLabel } });
    rewrites += 1;
    i += 1;
  }
  return rewrites;
}

function ensureLabel(items, index, prefix) {
  const existing = trimLabel(items[index] && items[index].labelDef);
  if (existing) return existing;
  const used = new Set();
  for (const item of items) {
    const label = trimLabel(item && item.labelDef);
    if (label) used.add(label);
  }
  let label = prefix;
  let n = 0;
  while (used.has(label)) {
    n += 1;
    label = `${prefix}_${n}`;
  }
  items[index].labelDef = `${label}:`;
  return label;
}

function mergeAdjacentConstReturns(code) {
  if ((code.exceptionTable || []).length > 0) return 0;
  const items = code.codeItems;
  let rewrites = 0;
  for (let i = 0; i < items.length; i += 1) {
    const ret1 = nextInstructionIndex(items, i);
    if (!isConstOp(op(items[i])) || ret1 < 0 || !isReturnOp(op(items[ret1]))) continue;
    const secondConst = nextInstructionIndex(items, ret1);
    const ret2 = nextInstructionIndex(items, secondConst);
    if (secondConst < 0 || ret2 < 0) continue;
    if (op(items[secondConst]) !== op(items[i]) || op(items[ret2]) !== op(items[ret1])) continue;
    const firstLabel = trimLabel(items[i].labelDef);
    const secondLabel = trimLabel(items[secondConst].labelDef);
    if (!firstLabel || !secondLabel || isExceptionLabel(code.exceptionTable || [], secondLabel)) continue;
    retargetLabel(code, secondLabel, firstLabel);
    rewrites += 1;
  }
  return rewrites;
}

function retargetLabel(code, from, to) {
  for (const item of code.codeItems || []) {
    const insn = item && item.instruction;
    if (!insn || typeof insn !== 'object') continue;
    if (typeof insn.arg === 'string' && trimLabel(insn.arg) === from) {
      insn.arg = to;
    }
  }
}

function isExceptionLabel(exceptionTable, label) {
  for (const entry of exceptionTable || []) {
    for (const value of [entry.startLbl, entry.endLbl, entry.handlerLbl, entry.startLabel, entry.endLabel, entry.handlerLabel]) {
      if (trimLabel(value) === label) return true;
    }
  }
  return false;
}

function collapseGotoChains(code) {
  const items = code.codeItems;
  let rewrites = 0;
  let changed = true;
  while (changed) {
    changed = false;
    const labels = buildLabelIndex(items);
    for (const item of items) {
      if (op(item) !== 'goto') continue;
      const target = trimLabel(arg(item));
      const targetIndex = labels.get(target);
      if (targetIndex == null) continue;
      const next = nextInstructionIndex(items, targetIndex - 1);
      if (next < 0 || op(items[next]) !== 'goto') continue;
      const finalTarget = trimLabel(arg(items[next]));
      if (!finalTarget || finalTarget === target) continue;
      item.instruction = { ...item.instruction, arg: finalTarget };
      rewrites += 1;
      changed = true;
    }
  }
  return rewrites;
}

function inlineGotoConstReturns(code) {
  const items = code.codeItems;
  const labels = buildLabelIndex(items);
  let rewrites = 0;
  for (const item of items) {
    if (op(item) !== 'goto') continue;
    const target = trimLabel(arg(item));
    const targetIndex = labels.get(target);
    if (targetIndex == null) continue;
    const first = nextInstructionIndex(items, targetIndex - 1);
    const second = nextInstructionIndex(items, first);
    if (first < 0 || second < 0) continue;
    if (!isConstOp(op(items[first])) || !isReturnOp(op(items[second]))) continue;
    item.instruction = cloneInstruction(items[first].instruction);
    items.splice(items.indexOf(item) + 1, 0, { instruction: cloneInstruction(items[second].instruction) });
    rewrites += 1;
  }
  return rewrites;
}

function isConstOp(itemOp) {
  return itemOp === 'iconst_0' || itemOp === 'iconst_1';
}

function isReturnOp(itemOp) {
  return itemOp === 'ireturn' || itemOp === 'lreturn' || itemOp === 'freturn' ||
    itemOp === 'dreturn' || itemOp === 'areturn' || itemOp === 'return';
}

function cloneInstruction(insn) {
  if (!insn || typeof insn === 'string') return insn;
  return { ...insn, arg: cloneValue(insn.arg) };
}

function cloneValue(value) {
  return Array.isArray(value) ? value.map(cloneValue) : value;
}

function removeUnreferencedAfterTerminals(code) {
  const items = code.codeItems;
  const protectedLabels = exceptionLabels(code.exceptionTable || []);
  let rewrites = 0;
  for (let i = 0; i < items.length; i += 1) {
    if (!TERMINALS.has(op(items[i]))) continue;
    const used = collectReferencedLabels(code);
    let j = i + 1;
    while (j < items.length) {
      const item = items[j];
      const label = trimLabel(item && item.labelDef);
      if (label && (used.has(label) || protectedLabels.has(label))) break;
      if (item && item.instruction) rewrites += 1;
      items.splice(j, 1);
    }
  }
  return rewrites;
}

function collectReferencedLabels(code) {
  const used = exceptionLabels(code.exceptionTable || []);
  for (const item of code.codeItems || []) {
    for (const label of instructionLabels(item && item.instruction)) used.add(label);
  }
  return used;
}

function instructionLabels(insn) {
  if (!insn || typeof insn !== 'object') return [];
  if (typeof insn.arg === 'string') return [trimLabel(insn.arg)].filter(Boolean);
  const out = [];
  if (insn.op === 'tableswitch' || insn.op === 'lookupswitch') {
    collectLabelsFromValue(insn.arg, out);
    collectLabelsFromValue(insn.labels, out);
    collectLabelsFromValue(insn.defaultLbl, out);
  }
  return out;
}

function collectLabelsFromValue(value, out) {
  if (!value) return;
  if (typeof value === 'string') {
    const label = trimLabel(value);
    if (label) out.push(label);
  } else if (Array.isArray(value)) {
    for (const entry of value) collectLabelsFromValue(entry, out);
  }
}

function exceptionLabels(exceptionTable) {
  const out = new Set();
  for (const entry of exceptionTable || []) {
    for (const label of [entry.startLbl, entry.endLbl, entry.handlerLbl, entry.startLabel, entry.endLabel, entry.handlerLabel]) {
      const normalized = trimLabel(label);
      if (normalized) out.add(normalized);
    }
  }
  return out;
}

function buildLabelIndex(items) {
  const labels = new Map();
  for (let i = 0; i < items.length; i += 1) {
    const label = trimLabel(items[i] && items[i].labelDef);
    if (label) labels.set(label, i);
  }
  return labels;
}

function nextInstructionIndex(items, index) {
  for (let i = index + 1; i < items.length; i += 1) {
    if (items[i] && items[i].instruction) return i;
  }
  return -1;
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
  runControlFlowDce,
  mergeAdjacentConstReturns,
  shareConstReturnGotos,
  collapseGotoChains,
  inlineGotoConstReturns,
  removeUnreferencedAfterTerminals,
};

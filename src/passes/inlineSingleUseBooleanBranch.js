'use strict';

const BOOL_BRANCHES = new Set(['ifeq', 'ifne']);

function runInlineSingleUseBooleanBranch(astRoot) {
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
  const referenced = referencedLabels(code);
  const labelIndexes = labelIndexMap(items);
  let rewrites = 0;
  rewrites += rewriteLoopCarriedBooleanTemps(code, referenced, labelIndexes);
  rewrites += intizeBooleanFieldStores(code, referenced);
  for (let i = 0; i + 2 < items.length; i += 1) {
    if (!isBooleanProducingCall(items[i - 1])) continue;
    const local = istoreLocal(items[i]);
    if (local == null) continue;
    if (iloadLocal(items[i + 1]) !== local) continue;
    const branchOp = op(items[i + 2]);
    if (!BOOL_BRANCHES.has(branchOp)) continue;
    if (localReadReachableBeforeOverwrite(items, labelIndexes, i + 2, local)) continue;
    if (isReferencedLabel(items[i], referenced) || isReferencedLabel(items[i + 1], referenced)) continue;

    if (items[i].labelDef) {
      items[i + 2].labelDef = items[i + 2].labelDef || items[i].labelDef;
    } else if (items[i + 1].labelDef) {
      items[i + 2].labelDef = items[i + 2].labelDef || items[i + 1].labelDef;
    }
    items.splice(i, 2);
    rewrites += 1;
  }
  return rewrites;
}

function intizeBooleanFieldStores(code, referenced) {
  const items = code.codeItems;
  let rewrites = 0;
  for (let i = 0; i + 1 < items.length; i += 1) {
    if (!isBooleanFieldRead(items[i])) continue;
    const local = istoreLocal(items[i + 1]);
    if (local == null) continue;
    if (isReferencedLabel(items[i + 1], referenced)) continue;
    if (!hasNonBooleanIntegerStore(items, local, i + 1)) continue;

    const falseLabel = freshLabel(items, 'L_bool_false');
    const storeLabel = freshLabel(items, 'L_bool_store');
    const storeItem = { ...items[i + 1] };
    delete storeItem.labelDef;
    items.splice(
      i + 1,
      1,
      { instruction: { op: 'ifeq', arg: falseLabel } },
      { instruction: 'iconst_1' },
      { instruction: { op: 'goto', arg: storeLabel } },
      { labelDef: `${falseLabel}:`, instruction: 'iconst_0' },
      { labelDef: `${storeLabel}:`, instruction: storeItem.instruction },
    );
    rewrites += 1;
    i += 5;
  }
  return rewrites;
}

function isBooleanFieldRead(item) {
  const itemOp = op(item);
  if (itemOp !== 'getstatic' && itemOp !== 'getfield') return false;
  const ref = arg(item);
  return Array.isArray(ref) && Array.isArray(ref[2]) && ref[2][1] === 'Z';
}

function hasNonBooleanIntegerStore(items, local, skipIndex) {
  for (let i = 0; i < items.length; i += 1) {
    if (i === skipIndex || istoreLocal(items[i]) !== local) continue;
    if (!isBooleanProducer(previousInstruction(items, i))) return true;
  }
  return false;
}

function isBooleanProducer(item) {
  return isBooleanProducingCall(item) || isBooleanFieldRead(item);
}

function previousInstruction(items, index) {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (items[i] && items[i].instruction) return items[i];
  }
  return null;
}

function rewriteLoopCarriedBooleanTemps(code, referenced, labelIndexes) {
  const items = code.codeItems;
  let rewrites = 0;
  for (let i = 0; i + 6 < items.length; i += 1) {
    if (!isBooleanProducingCall(items[i])) continue;
    const local = istoreLocal(items[i + 1]);
    if (local == null) continue;
    if (iloadLocal(items[i + 2]) !== local) continue;
    const branchOp = op(items[i + 3]);
    if (!BOOL_BRANCHES.has(branchOp)) continue;
    const exitLabel = trimLabel(arg(items[i + 3]));
    const loopLabel = trimLabel(items[i + 2].labelDef);
    if (!exitLabel || !loopLabel) continue;
    if (labelReferenceCount(code, loopLabel) !== 1) continue;
    if (isReferencedLabel(items[i + 1], referenced)) continue;

    const second = findLoopCarriedBooleanStore(items, i + 4, local, loopLabel);
    if (!second) continue;
    if (hasLocalReadOrWrite(items, i + 4, second.callIndex, local)) continue;

    const middleLabel = ensureLabel(items, i + 4);
    items[second.gotoIndex] = { ...items[second.gotoIndex], instruction: { op: 'goto', arg: middleLabel } };
    items[second.storeIndex] = {
      ...items[second.storeIndex],
      labelDef: items[second.storeIndex].labelDef || undefined,
      instruction: { op: branchOp, arg: exitLabel },
    };
    items.splice(i + 2, 1);
    items.splice(i + 1, 1);
    rewrites += 1;
  }
  return rewrites;
}

function findLoopCarriedBooleanStore(items, start, local, loopLabel) {
  for (let i = start; i + 2 < items.length; i += 1) {
    if (isTerminator(op(items[i]))) return null;
    if (!isBooleanProducingCall(items[i])) continue;
    if (istoreLocal(items[i + 1]) !== local) continue;
    if (op(items[i + 2]) !== 'goto' || trimLabel(arg(items[i + 2])) !== loopLabel) continue;
    return { callIndex: i, storeIndex: i + 1, gotoIndex: i + 2 };
  }
  return null;
}

function hasLocalReadOrWrite(items, start, end, local) {
  for (let i = start; i < end; i += 1) {
    if (iloadLocal(items[i]) === local || istoreLocal(items[i]) === local) return true;
  }
  return false;
}

function labelReferenceCount(code, label) {
  let count = 0;
  for (const item of code.codeItems || []) {
    for (const target of branchTargets(item)) {
      if (trimLabel(target) === label) count += 1;
    }
  }
  for (const entry of code.exceptionTable || []) {
    for (const target of [entry.startLbl, entry.endLbl, entry.handlerLbl]) {
      if (trimLabel(target) === label) count += 1;
    }
  }
  return count;
}

function ensureLabel(items, index) {
  const existing = trimLabel(items[index] && items[index].labelDef);
  if (existing) return existing;
  const label = freshLabel(items, 'L_inline_bool');
  items[index].labelDef = `${label}:`;
  return label;
}

function freshLabel(items, prefix) {
  const used = new Set(items.map((item) => trimLabel(item && item.labelDef)).filter(Boolean));
  let n = 0;
  let label = prefix;
  while (used.has(label)) {
    n += 1;
    label = `${prefix}_${n}`;
  }
  return label;
}

function isTerminator(itemOp) {
  return itemOp === 'return' || itemOp === 'ireturn' || itemOp === 'lreturn' || itemOp === 'freturn' ||
    itemOp === 'dreturn' || itemOp === 'areturn' || itemOp === 'athrow';
}

function isBooleanProducingCall(item) {
  const itemOp = op(item);
  if (itemOp !== 'invokestatic' && itemOp !== 'invokevirtual' && itemOp !== 'invokeinterface' && itemOp !== 'invokespecial') {
    return false;
  }
  const itemArg = arg(item);
  return methodDescriptor(itemArg).endsWith('Z');
}

function methodDescriptor(itemArg) {
  if (!Array.isArray(itemArg)) return '';
  if (itemArg[0] !== 'Method' && itemArg[0] !== 'InterfaceMethod') return '';
  return Array.isArray(itemArg[2]) && typeof itemArg[2][1] === 'string' ? itemArg[2][1] : '';
}

function iloadLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'iload') return String(arg(item));
  if (/^iload_[0-3]$/.test(itemOp || '')) return itemOp.slice(-1);
  return null;
}

function istoreLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'istore') return String(arg(item));
  if (/^istore_[0-3]$/.test(itemOp || '')) return itemOp.slice(-1);
  return null;
}

function referencedLabels(code) {
  const out = new Set();
  for (const item of code.codeItems || []) {
    for (const label of branchTargets(item)) out.add(trimLabel(label));
  }
  for (const entry of code.exceptionTable || []) {
    for (const label of [entry.startLbl, entry.endLbl, entry.handlerLbl]) out.add(trimLabel(label));
  }
  out.delete(null);
  return out;
}

function labelIndexMap(items) {
  const out = new Map();
  for (let i = 0; i < items.length; i += 1) {
    const label = trimLabel(items[i] && items[i].labelDef);
    if (label) out.set(label, i);
  }
  return out;
}

function localReadReachableBeforeOverwrite(items, labelIndexes, branchIndex, local) {
  const starts = successors(items, labelIndexes, branchIndex);
  const seen = new Set();
  const stack = [...starts];
  while (stack.length) {
    const index = stack.pop();
    if (index == null || index < 0 || index >= items.length || seen.has(index)) continue;
    seen.add(index);
    if (iloadLocal(items[index]) === local) return true;
    if (istoreLocal(items[index]) === local) continue;
    for (const next of successors(items, labelIndexes, index)) stack.push(next);
  }
  return false;
}

function successors(items, labelIndexes, index) {
  const itemOp = op(items[index]);
  if (!itemOp) return index + 1 < items.length ? [index + 1] : [];
  if (itemOp === 'return' || itemOp === 'ireturn' || itemOp === 'lreturn' || itemOp === 'freturn' ||
      itemOp === 'dreturn' || itemOp === 'areturn' || itemOp === 'athrow') {
    return [];
  }
  if (itemOp === 'goto' || itemOp === 'goto_w') {
    const target = labelIndexes.get(trimLabel(arg(items[index])));
    return target == null ? [] : [target];
  }
  if (itemOp === 'tableswitch' || itemOp === 'lookupswitch') {
    return branchTargets(items[index])
      .map((label) => labelIndexes.get(trimLabel(label)))
      .filter((target) => target != null);
  }
  if (/^if/.test(itemOp)) {
    const target = labelIndexes.get(trimLabel(arg(items[index])));
    const out = [];
    if (target != null) out.push(target);
    if (index + 1 < items.length) out.push(index + 1);
    return out;
  }
  return index + 1 < items.length ? [index + 1] : [];
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

function isReferencedLabel(item, referenced) {
  const label = trimLabel(item && item.labelDef);
  return !!label && referenced.has(label);
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
  runInlineSingleUseBooleanBranch,
  rewriteCode,
};

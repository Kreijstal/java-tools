'use strict';

function runConstructorPreSuperCleanup(astRoot, options = {}) {
  let methods = 0;
  let deletedSnapshots = 0;
  for (const cls of astRoot.classes || []) {
    for (const item of cls.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      const method = item.method;
      if (method.name !== '<init>') continue;
      const code = codeOf(method);
      if (!code) continue;
      const result = cleanConstructor(code, cls, options);
      if (result.deletedSnapshots > 0) {
        methods += 1;
        deletedSnapshots += result.deletedSnapshots;
      }
    }
  }
  return { changed: deletedSnapshots > 0, methods, deletedSnapshots };
}

function cleanConstructor(code, cls, options = {}) {
  const codeItems = code.codeItems || [];
  const superIndex = findFirstConstructorCall(codeItems, cls);
  if (superIndex == null) return { deletedSnapshots: 0 };
  if (constructorCallInsidePreexistingTry(code, codeItems, superIndex)) return { deletedSnapshots: 0 };

  const firstInstruction = nextInstructionIndex(codeItems, 0);
  if (firstInstruction == null) return { deletedSnapshots: 0 };
  const snapshot = matchSnapshotAt(codeItems, firstInstruction);
  if (!snapshot) return { deletedSnapshots: 0 };
  if (snapshot.storeIndex >= superIndex) return { deletedSnapshots: 0 };
  if (hasControlFlowBefore(codeItems, superIndex)) return { deletedSnapshots: 0 };
  if (labelTargeted(code, codeItems, snapshot.storeIndex)) return { deletedSnapshots: 0 };
  if (localUsedAfter(codeItems, snapshot.local, superIndex)) return { deletedSnapshots: 0 };
  if (options.deleteUnusedSnapshots === false) return { deletedSnapshots: 0 };

  removeInstructionOnly(codeItems, snapshot.storeIndex);
  removeInstructionOnly(codeItems, snapshot.getIndex);
  return { deletedSnapshots: 1 };
}

function matchSnapshotAt(codeItems, getIndex) {
  const getItem = codeItems[getIndex];
  if (op(getItem) !== 'getstatic') return null;
  const getArg = arg(getItem);
  if (!Array.isArray(getArg) || getArg[0] !== 'Field' || !Array.isArray(getArg[2]) || getArg[2][1] !== 'Z') {
    return null;
  }
  const storeIndex = nextInstructionIndex(codeItems, getIndex + 1);
  if (storeIndex == null) return null;
  const local = intStoreLocal(codeItems[storeIndex]);
  if (local == null) return null;
  return { getIndex, storeIndex, local };
}

function findFirstConstructorCall(codeItems, cls) {
  for (let i = 0; i < codeItems.length; i += 1) {
    if (op(codeItems[i]) !== 'invokespecial') continue;
    const itemArg = arg(codeItems[i]);
    if (!Array.isArray(itemArg) || itemArg[0] !== 'Method' || !Array.isArray(itemArg[2])) continue;
    if (itemArg[2][0] !== '<init>') continue;
    const owner = itemArg[1];
    if (owner === cls.className || owner === cls.superClassName) return i;
  }
  return null;
}

function constructorCallInsidePreexistingTry(code, codeItems, superIndex) {
  const superLabel = nearestLabelAtOrBefore(codeItems, superIndex);
  if (!superLabel) return false;
  const labelOrder = labelInstructionOrder(codeItems);
  const superOrder = labelOrder.get(superLabel);
  for (const entry of code.exceptionTable || []) {
    const start = trimLabel(entry.startLbl || entry.startLabel || entry.start);
    const end = trimLabel(entry.endLbl || entry.endLabel || entry.end);
    if (!labelOrder.has(start) || !labelOrder.has(end)) continue;
    if (labelOrder.get(start) < superOrder && superOrder < labelOrder.get(end)) return true;
  }
  return false;
}

function labelInstructionOrder(codeItems) {
  const result = new Map();
  let order = 0;
  let pending = [];
  for (const item of codeItems) {
    if (item && item.labelDef) pending.push(trimLabel(item.labelDef));
    if (!item || !item.instruction) continue;
    for (const label of pending) result.set(label, order);
    pending = [];
    order += 1;
  }
  for (const label of pending) result.set(label, order);
  return result;
}

function nearestLabelAtOrBefore(codeItems, index) {
  for (let i = index; i >= 0; i -= 1) {
    if (codeItems[i] && codeItems[i].labelDef) return trimLabel(codeItems[i].labelDef);
  }
  return null;
}

function hasControlFlowBefore(codeItems, endIndex) {
  for (let i = 0; i < endIndex; i += 1) {
    const itemOp = op(codeItems[i]);
    if (!itemOp) continue;
    if (itemOp === 'goto' || itemOp === 'jsr' || itemOp === 'ret' || itemOp.endsWith('return') || itemOp === 'athrow') return true;
    if (itemOp.startsWith('if') || itemOp === 'tableswitch' || itemOp === 'lookupswitch') return true;
  }
  return false;
}

function labelTargeted(code, codeItems, index) {
  const label = codeItems[index] && codeItems[index].labelDef && trimLabel(codeItems[index].labelDef);
  if (!label) return false;
  for (const entry of code.exceptionTable || []) {
    if (trimLabel(entry.startLbl || entry.startLabel || entry.start) === label) return true;
    if (trimLabel(entry.endLbl || entry.endLabel || entry.end) === label) return true;
    if (trimLabel(entry.handlerLbl || entry.handlerLabel || entry.handler || entry.usingLbl) === label) return true;
  }
  for (let i = 0; i < codeItems.length; i += 1) {
    if (i === index) continue;
    if (instructionReferencesLabel(codeItems[i] && codeItems[i].instruction, label)) return true;
  }
  return false;
}

function localUsedAfter(codeItems, local, startIndex) {
  for (let i = startIndex + 1; i < codeItems.length; i += 1) {
    if (intLoadLocal(codeItems[i]) === local) return true;
    if (intStoreLocal(codeItems[i]) === local) return true;
    const itemOp = op(codeItems[i]);
    if (itemOp === 'iinc' && String((arg(codeItems[i]) || [])[0]) === local) return true;
  }
  return false;
}

function nextInstructionIndex(codeItems, start) {
  for (let i = start; i < codeItems.length; i += 1) {
    if (codeItems[i] && codeItems[i].instruction) return i;
  }
  return null;
}

function removeInstructionOnly(codeItems, index) {
  const item = codeItems[index];
  if (!item) return;
  if (item.labelDef || item.stackMapFrame || item.lineNumber) {
    delete item.instruction;
    delete item.pc;
  } else {
    codeItems.splice(index, 1);
  }
}

function codeOf(method) {
  const attr = (method.attributes || []).find((a) => a && a.type === 'code');
  return attr && attr.code && Array.isArray(attr.code.codeItems) ? attr.code : null;
}

function intLoadLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'iload') return String(arg(item));
  if (/^iload_[0-3]$/.test(itemOp || '')) return itemOp.slice(-1);
  return null;
}

function intStoreLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'istore') return String(arg(item));
  if (/^istore_[0-3]$/.test(itemOp || '')) return itemOp.slice(-1);
  return null;
}

function instructionReferencesLabel(instruction, label) {
  if (!instruction || typeof instruction !== 'object') return false;
  return containsLabel(instruction.arg, label);
}

function containsLabel(value, label) {
  if (!value) return false;
  if (typeof value === 'string') return trimLabel(value) === label;
  if (Array.isArray(value)) return value.some((v) => containsLabel(v, label));
  if (typeof value === 'object') return Object.values(value).some((v) => containsLabel(v, label));
  return false;
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
  return typeof label === 'string' && label.endsWith(':') ? label.slice(0, -1) : label;
}

module.exports = { runConstructorPreSuperCleanup, cleanConstructor };

'use strict';

const { normalizeInstruction } = require('./utils/instructionUtils');

const MAX_LOOP_ITERATIONS = 100000;

function isInstruction(item) {
  return item && item.instruction;
}

function normalizeLabel(label) {
  if (typeof label !== 'string') {
    return null;
  }
  return label.endsWith(':') ? label.slice(0, -1) : label;
}

function copyLocals(locals) {
  const clone = new Map();
  locals.forEach((value, key) => clone.set(key, value));
  return clone;
}

function createIntConstantInstruction(value) {
  if (!Number.isInteger(value)) {
    return null;
  }
  if (value === -1) return 'iconst_m1';
  if (value >= 0 && value <= 5) {
    return `iconst_${value}`;
  }
  if (value >= -128 && value <= 127) {
    return { op: 'bipush', arg: String(value) };
  }
  if (value >= -32768 && value <= 32767) {
    return { op: 'sipush', arg: String(value) };
  }
  return { op: 'ldc', arg: String(value) };
}

function createStoreInstruction(index) {
  if (!Number.isInteger(index) || index < 0) {
    return null;
  }
  if (index >= 0 && index <= 3) {
    return `istore_${index}`;
  }
  return { op: 'istore', arg: String(index) };
}

function getLocalIndex(normalized, original) {
  if (!normalized || !normalized.op) return null;
  if (normalized.op.startsWith('iload') || normalized.op.startsWith('istore')) {
    const parts = normalized.op.split('_');
    if (parts.length === 2) {
      const idx = Number.parseInt(parts[1], 10);
      return Number.isInteger(idx) ? idx : null;
    }
    if (typeof normalized.arg === 'number') {
      return normalized.arg;
    }
    if (typeof normalized.arg === 'string' && normalized.arg.length) {
      const parsed = Number.parseInt(normalized.arg, 10);
      return Number.isInteger(parsed) ? parsed : null;
    }
    if (original && typeof original.arg === 'string') {
      const parsed = Number.parseInt(original.arg, 10);
      return Number.isInteger(parsed) ? parsed : null;
    }
  }
  return null;
}

function evaluatePrefix(codeItems, endIndex) {
  const locals = new Map();
  const stack = [];
  for (let i = 0; i < endIndex; i += 1) {
    const item = codeItems[i];
    if (!isInstruction(item)) {
      continue;
    }
    if (!executeInstruction(item.instruction, stack, locals)) {
      return null;
    }
  }
  if (stack.length !== 0) {
    return null;
  }
  return locals;
}

function executeInstruction(instr, stack, locals) {
  if (!instr) {
    return true;
  }
  const normalized = normalizeInstruction(instr);
  if (!normalized || !normalized.op) {
    return false;
  }
  const op = normalized.op;
  if (op.startsWith('iconst_')) {
    if (op === 'iconst_m1') {
      stack.push(-1);
    } else {
      const value = Number.parseInt(op.slice('iconst_'.length), 10);
      stack.push(value);
    }
    return true;
  }
  if (op === 'bipush' || op === 'sipush') {
    const value = Number.parseInt(normalized.arg, 10);
    if (!Number.isInteger(value)) {
      return false;
    }
    stack.push(value);
    return true;
  }
  if (op === 'ldc') {
    const arg = normalized.arg;
    if (typeof arg === 'number') {
      stack.push(arg | 0);
      return true;
    }
    if (typeof arg === 'string' && /^[+-]?\d+$/.test(arg)) {
      stack.push(Number.parseInt(arg, 10));
      return true;
    }
    return false;
  }
  if (op.startsWith('iload')) {
    const index = getLocalIndex(normalized, instr);
    if (index === null || !locals.has(index)) {
      return false;
    }
    stack.push(locals.get(index));
    return true;
  }
  if (op.startsWith('istore')) {
    const index = getLocalIndex(normalized, instr);
    if (index === null || stack.length === 0) {
      return false;
    }
    const value = stack.pop();
    if (!Number.isInteger(value)) {
      return false;
    }
    locals.set(index, value);
    return true;
  }
  if (op === 'iadd' || op === 'isub' || op === 'imul' || op === 'idiv' || op === 'irem') {
    if (stack.length < 2) {
      return false;
    }
    const rhs = stack.pop();
    const lhs = stack.pop();
    if (!Number.isInteger(lhs) || !Number.isInteger(rhs)) {
      return false;
    }
    let result;
    switch (op) {
      case 'iadd':
        result = (lhs + rhs) | 0;
        break;
      case 'isub':
        result = (lhs - rhs) | 0;
        break;
      case 'imul':
        result = (lhs * rhs) | 0;
        break;
      case 'idiv':
        if (rhs === 0) {
          return false;
        }
        result = (lhs / rhs) | 0;
        break;
      case 'irem':
        if (rhs === 0) {
          return false;
        }
        result = lhs % rhs;
        break;
      default:
        return false;
    }
    stack.push(result);
    return true;
  }
  if (op === 'iinc') {
    const index = Number.parseInt(instr.varnum ?? instr.index ?? instr.arg, 10);
    const amount = Number.parseInt(instr.incr ?? 0, 10);
    if (!Number.isInteger(index) || !Number.isInteger(amount) || !locals.has(index)) {
      return false;
    }
    const updated = (locals.get(index) + amount) | 0;
    locals.set(index, updated);
    return true;
  }
  if (op === 'nop') {
    return true;
  }
  return false;
}

function compareCounter(op, counter, limit) {
  switch (op) {
    case 'if_icmpgt':
      return counter > limit;
    case 'if_icmpge':
      return counter >= limit;
    case 'if_icmplt':
      return counter < limit;
    case 'if_icmple':
      return counter <= limit;
    case 'if_icmpeq':
      return counter === limit;
    case 'if_icmpne':
      return counter !== limit;
    default:
      return null;
  }
}

function detectLoop(codeItems, gotoIndex) {
  let iincIdx = gotoIndex - 1;
  while (iincIdx >= 0 && !isInstruction(codeItems[iincIdx])) {
    iincIdx -= 1;
  }
  if (iincIdx < 0) {
    return null;
  }
  const iincInstr = codeItems[iincIdx].instruction;
  if (!iincInstr || normalizeInstruction(iincInstr)?.op !== 'iinc') {
    return null;
  }

  const gotoInstr = codeItems[gotoIndex].instruction;
  if (!gotoInstr || gotoInstr.op !== 'goto') {
    return null;
  }
  const startLabel = normalizeLabel(gotoInstr.arg);
  if (!startLabel) {
    return null;
  }

  const startIdx = codeItems.findIndex(
    (item) => item && normalizeLabel(item.labelDef) === startLabel,
  );
  if (startIdx === -1) {
    return null;
  }

  let loadCounterIdx = startIdx;
  while (loadCounterIdx < codeItems.length && !isInstruction(codeItems[loadCounterIdx])) {
    loadCounterIdx += 1;
  }
  const loadCounter = codeItems[loadCounterIdx];
  if (!isInstruction(loadCounter)) {
    return null;
  }
  const counterIndex = getLocalIndex(normalizeInstruction(loadCounter.instruction), loadCounter.instruction);
  if (counterIndex === null) {
    return null;
  }

  let loadLimitIdx = loadCounterIdx + 1;
  while (loadLimitIdx < codeItems.length && !isInstruction(codeItems[loadLimitIdx])) {
    loadLimitIdx += 1;
  }
  const loadLimit = codeItems[loadLimitIdx];
  if (!isInstruction(loadLimit)) {
    return null;
  }

  let branchInstrIdx = loadLimitIdx + 1;
  while (branchInstrIdx < codeItems.length && !isInstruction(codeItems[branchInstrIdx])) {
    branchInstrIdx += 1;
  }
  const branchItem = codeItems[branchInstrIdx];
  if (!isInstruction(branchItem)) {
    return null;
  }
  const branchNorm = normalizeInstruction(branchItem.instruction);
  if (
    !branchNorm ||
    !branchNorm.op ||
    !branchNorm.op.startsWith('if_icmp')
  ) {
    return null;
  }
  const exitLabel = normalizeLabel(branchItem.instruction.arg);
  if (!exitLabel) {
    return null;
  }

  const bodyStartIdx = branchInstrIdx + 1;
  if (bodyStartIdx >= iincIdx) {
    return null;
  }

  for (let idx = bodyStartIdx; idx < iincIdx; idx += 1) {
    const item = codeItems[idx];
    if (!isInstruction(item)) {
      continue;
    }
    const op = normalizeInstruction(item.instruction)?.op;
    if (!op) {
      return null;
    }
    if (op.startsWith('if_') || op === 'goto' || op === 'jsr' || op === 'ret') {
      return null;
    }
  }

  return {
    counterIndex,
    loadLimitIdx,
    loadCounterIdx,
    branchIdx: branchInstrIdx,
    bodyStartIdx,
    iincIdx,
    gotoIdx: gotoIndex,
    exitLabel,
    startIdx,
    branchOp: branchNorm.op,
  };
}

function readValueFromInstruction(item, locals) {
  if (!isInstruction(item)) {
    return null;
  }
  const normalized = normalizeInstruction(item.instruction);
  if (!normalized || !normalized.op) {
    return null;
  }
  if (normalized.op.startsWith('iconst_') || normalized.op === 'bipush' || normalized.op === 'sipush' || normalized.op === 'ldc') {
    const stack = [];
    if (!executeInstruction(item.instruction, stack, new Map())) {
      return null;
    }
    return stack.pop();
  }
  if (normalized.op.startsWith('iload')) {
    const index = getLocalIndex(normalized, item.instruction);
    if (index === null || !locals.has(index)) {
      return null;
    }
    return locals.get(index);
  }
  return null;
}

function executeBody(codeItems, startIdx, endIdx, locals) {
  const stack = [];
  for (let idx = startIdx; idx < endIdx; idx += 1) {
    const item = codeItems[idx];
    if (!isInstruction(item)) {
      continue;
    }
    if (!executeInstruction(item.instruction, stack, locals)) {
      return false;
    }
  }
  return stack.length === 0;
}

function evaluateLoop(codeItems, loopInfo, prefixLocals) {
  const locals = copyLocals(prefixLocals);
  const limitValue = readValueFromInstruction(codeItems[loopInfo.loadLimitIdx], locals);
  if (!Number.isInteger(limitValue)) {
    return null;
  }
  if (!locals.has(loopInfo.counterIndex)) {
    return null;
  }
  const loopLocals = new Set([loopInfo.counterIndex]);
  for (let idx = loopInfo.bodyStartIdx; idx < loopInfo.iincIdx; idx += 1) {
    const item = codeItems[idx];
    if (!isInstruction(item)) {
      continue;
    }
    const normalized = normalizeInstruction(item.instruction);
    if (!normalized) {
      return null;
    }
    if (normalized.op.startsWith('iload') || normalized.op.startsWith('istore') || normalized.op === 'iinc') {
      const localIndex = getLocalIndex(normalized, item.instruction);
      if (localIndex !== null) {
        loopLocals.add(localIndex);
      }
    }
  }

  let iterations = 0;
  while (true) {
    if (!locals.has(loopInfo.counterIndex)) {
      return null;
    }
    const counterValue = locals.get(loopInfo.counterIndex);
    const cmp = compareCounter(loopInfo.branchOp, counterValue, limitValue);
    if (cmp === null) {
      return null;
    }
    if (cmp) {
      break;
    }
    if (
      !executeBody(
        codeItems,
        loopInfo.bodyStartIdx,
        loopInfo.iincIdx,
        locals,
      )
    ) {
      return null;
    }
    const iincInstr = codeItems[loopInfo.iincIdx].instruction;
    if (!executeInstruction(iincInstr, [], locals)) {
      return null;
    }
    iterations += 1;
    if (iterations > MAX_LOOP_ITERATIONS) {
      return null;
    }
  }

  return { locals, loopLocals };
}

function removeLoop(codeItems, loopInfo) {
  const preserved = [];
  for (let idx = loopInfo.startIdx; idx <= loopInfo.gotoIdx; idx += 1) {
    const item = codeItems[idx];
    if (item && item.labelDef) {
      preserved.push({ labelDef: item.labelDef });
    }
  }
  const removed = loopInfo.gotoIdx - loopInfo.startIdx + 1;
  codeItems.splice(loopInfo.startIdx, removed, ...preserved);
  return removed - preserved.length;
}

function insertFinalStores(codeItems, exitLabel, loopLocals, beforeLocals, afterLocals) {
  const labelIdx = codeItems.findIndex(
    (item) => item && normalizeLabel(item.labelDef) === exitLabel,
  );
  if (labelIdx === -1) {
    return false;
  }
  const stores = [];
  const sortedLocals = Array.from(loopLocals).sort((a, b) => a - b);
  for (const localIndex of sortedLocals) {
    const before = beforeLocals.get(localIndex);
    const after = afterLocals.get(localIndex);
    if (after === undefined || after === before) {
      continue;
    }
    const constInstr = createIntConstantInstruction(after);
    const storeInstr = createStoreInstruction(localIndex);
    if (!constInstr || !storeInstr) {
      return false;
    }
    stores.push({ instruction: constInstr });
    stores.push({ instruction: storeInstr });
  }
  if (!stores.length) {
    return false;
  }
  codeItems.splice(labelIdx, 0, ...stores);
  return true;
}

function evaluateLoopsInMethod(codeItems) {
  if (!Array.isArray(codeItems) || codeItems.length === 0) {
    return { changed: false };
  }
  let changed = false;
  let idx = 0;
  while (idx < codeItems.length) {
    const item = codeItems[idx];
    if (!isInstruction(item)) {
      idx += 1;
      continue;
    }
    const normalized = normalizeInstruction(item.instruction);
    if (!normalized || normalized.op !== 'goto') {
      idx += 1;
      continue;
    }
    const loopInfo = detectLoop(codeItems, idx);
    if (!loopInfo) {
      idx += 1;
      continue;
    }
    const prefixLocals = evaluatePrefix(codeItems, loopInfo.startIdx);
    if (!prefixLocals) {
      idx += 1;
      continue;
    }
    const evaluation = evaluateLoop(codeItems, loopInfo, prefixLocals);
    if (!evaluation) {
      idx += 1;
      continue;
    }
    const removed = removeLoop(codeItems, loopInfo);
    const success = insertFinalStores(
      codeItems,
      loopInfo.exitLabel,
      evaluation.loopLocals,
      prefixLocals,
      evaluation.locals,
    );
    if (!success) {
      idx += 1;
      continue;
    }
    changed = true;
    idx = Math.max(0, loopInfo.startIdx - removed);
  }
  return { changed };
}

function evaluateCounterLoops(program) {
  if (!program || !Array.isArray(program.classes)) {
    return { changed: false, loops: [] };
  }
  let changed = false;
  const loops = [];
  for (const cls of program.classes) {
    if (!cls || !Array.isArray(cls.items)) {
      continue;
    }
    const className = cls.className || '<anonymous>';
    for (const item of cls.items) {
      if (!item || item.type !== 'method' || !item.method) {
        continue;
      }
      const method = item.method;
      const codeAttr = (method.attributes || []).find((attr) => attr && attr.type === 'code');
      if (!codeAttr || !codeAttr.code || !Array.isArray(codeAttr.code.codeItems)) {
        continue;
      }
      const result = evaluateLoopsInMethod(codeAttr.code.codeItems);
      if (result.changed) {
        changed = true;
        loops.push({
          className,
          methodName: method.name,
          descriptor: method.descriptor,
        });
      }
    }
  }
  return { changed, loops };
}

module.exports = { evaluateCounterLoops };

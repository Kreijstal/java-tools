'use strict';

function runRemoveShadowingTrivialRethrowHandlers(astRoot) {
  const removals = [];
  for (const cls of astRoot.classes || []) {
    const className = cls.className || 'UnknownClass';
    for (const item of cls.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      const method = item.method;
      const code = codeOf(method);
      if (!code) continue;
      const result = removeFromCode(code);
      for (const removal of result.removals) {
        removals.push({ className, methodName: method.name, descriptor: method.descriptor, ...removal });
      }
    }
  }
  return { changed: removals.length > 0, removed: removals.length, removals };
}

function removeFromCode(code) {
  const exceptionTable = Array.isArray(code.exceptionTable) ? code.exceptionTable : [];
  if (exceptionTable.length < 2) return { removals: [] };
  const labelIndex = buildLabelIndex(code.codeItems || []);
  const pcIndex = buildPcIndex(code.codeItems || []);
  const handlerStartIndexes = buildHandlerStartIndexes(exceptionTable, labelIndex, pcIndex);
  const removals = [];
  const removeIndexes = new Set();

  for (let i = 0; i < exceptionTable.length; i += 1) {
    if (removeIndexes.has(i)) continue;
    const first = exceptionTable[i];
    const firstHandler = handlerLabel(first);
    if (!firstHandler) continue;
    const firstBlock = getLabelBlock(code.codeItems || [], labelIndex, pcIndex, handlerStartIndexes, firstHandler);
    if (!firstBlock || !isPureRethrowBlock(firstBlock.items)) continue;
    if (hasNormalReferencesToLabel(code.codeItems || [], firstHandler, firstBlock.startIndex, firstBlock.endIndex)) continue;

    for (let j = i + 1; j < exceptionTable.length; j += 1) {
      const later = exceptionTable[j];
      if (!sameProtectedCatch(first, later)) continue;
      const laterHandler = handlerLabel(later);
      if (!laterHandler || laterHandler === firstHandler) continue;
      const laterBlock = getLabelBlock(code.codeItems || [], labelIndex, pcIndex, handlerStartIndexes, laterHandler);
      if (laterBlock && isPureRethrowBlock(laterBlock.items)) continue;
      removeIndexes.add(i);
      removals.push({
        index: i,
        shadowedByIndex: j,
        startLabel: startLabel(first),
        endLabel: endLabel(first),
        catchType: catchType(first),
        handlerLabel: firstHandler,
        shadowedByHandlerLabel: laterHandler,
      });
      break;
    }
  }

  if (removeIndexes.size) {
    code.exceptionTable = exceptionTable.filter((_, i) => !removeIndexes.has(i));
  }
  return { removals };
}

function sameProtectedCatch(a, b) {
  return startLabel(a) === startLabel(b) && endLabel(a) === endLabel(b) && catchType(a) === catchType(b);
}

function isPureRethrowBlock(items) {
  const ops = [];
  for (const item of items || []) {
    const itemOp = op(item);
    if (!itemOp) continue;
    ops.push({ op: itemOp, arg: arg(item) });
  }
  if (ops.length === 1 && ops[0].op === 'athrow') return true;
  if (ops.length !== 3 || ops[2].op !== 'athrow') return false;
  const store = astoreLocalOp(ops[0]);
  const load = aloadLocalOp(ops[1]);
  return store != null && store === load;
}

function astoreLocalOp(insn) {
  if (insn.op === 'astore') return String(insn.arg);
  if (/^astore_[0-3]$/.test(insn.op || '')) return insn.op.slice(-1);
  return null;
}

function aloadLocalOp(insn) {
  if (insn.op === 'aload') return String(insn.arg);
  if (/^aload_[0-3]$/.test(insn.op || '')) return insn.op.slice(-1);
  return null;
}

function buildLabelIndex(codeItems) {
  const result = new Map();
  codeItems.forEach((item, i) => {
    if (item && item.labelDef) result.set(trimLabel(item.labelDef), i);
  });
  return result;
}

function buildPcIndex(codeItems) {
  const result = new Map();
  codeItems.forEach((item, i) => {
    if (item && typeof item.pc === 'number') result.set(item.pc, i);
  });
  return result;
}

function buildHandlerStartIndexes(exceptionTable, labelIndex, pcIndex) {
  const result = new Set();
  for (const entry of exceptionTable) {
    const label = handlerLabel(entry);
    if (!label) continue;
    let index = labelIndex.get(label);
    if (index == null) {
      const pc = pcFromLabel(label);
      if (pc != null) index = pcIndex.get(pc);
    }
    if (index != null) result.add(index);
  }
  return result;
}

function getLabelBlock(codeItems, labelIndex, pcIndex, handlerStartIndexes, label) {
  let startIndex = labelIndex.get(label);
  if (startIndex == null) {
    const pc = pcFromLabel(label);
    if (pc != null) startIndex = pcIndex.get(pc);
  }
  if (startIndex == null) return null;
  let endIndex = startIndex + 1;
  while (endIndex < codeItems.length && !handlerStartIndexes.has(endIndex)) {
    if (op(codeItems[endIndex - 1]) === 'athrow') break;
    endIndex += 1;
  }
  return { startIndex, endIndex, items: codeItems.slice(startIndex, endIndex) };
}

function hasNormalReferencesToLabel(codeItems, label, blockStart, blockEnd) {
  for (let i = 0; i < codeItems.length; i += 1) {
    if (i >= blockStart && i < blockEnd) continue;
    if (instructionReferencesLabel(codeItems[i] && codeItems[i].instruction, label)) return true;
  }
  return false;
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

function codeOf(method) {
  const attr = (method.attributes || []).find((a) => a && a.type === 'code');
  return attr && attr.code && Array.isArray(attr.code.codeItems) ? attr.code : null;
}

function startLabel(entry) {
  return trimLabel(entry && (entry.startLbl || entry.startLabel || entry.start || entry.from || entry.start_pc));
}

function endLabel(entry) {
  return trimLabel(entry && (entry.endLbl || entry.endLabel || entry.end || entry.to || entry.end_pc));
}

function handlerLabel(entry) {
  return trimLabel(entry && (entry.handlerLbl || entry.handlerLabel || entry.handler || entry.usingLbl || entry.handler_pc));
}

function catchType(entry) {
  return entry && (entry.catch_type || entry.catchType || entry.type || 'any');
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

function pcFromLabel(label) {
  if (typeof label === 'number') return label;
  if (typeof label !== 'string') return null;
  const match = /^L(\d+)$/.exec(trimLabel(label));
  return match ? Number(match[1]) : null;
}

module.exports = { runRemoveShadowingTrivialRethrowHandlers, removeFromCode, isPureRethrowBlock };

'use strict';

function removeRuntimeExceptionHandlers(astRoot, options = {}) {
  const keepHandlerCode = options.keepHandlerCode !== false;
  const preserveRecoveryHandlers = options.preserveRecoveryHandlers === true;
  let changed = false;
  const removals = [];

  for (const classItem of astRoot.classes || []) {
    const className = classItem.className || 'UnknownClass';
    for (const item of classItem.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      const method = item.method;
      const codeAttr = (method.attributes || []).find((attr) => attr && attr.type === 'code');
      const code = codeAttr && codeAttr.code;
      if (!code || !Array.isArray(code.exceptionTable) || code.exceptionTable.length === 0) continue;

      const kept = [];
      for (const entry of code.exceptionTable) {
        if (catchType(entry) !== 'java/lang/RuntimeException') {
          kept.push(entry);
          continue;
        }
        if (preserveRecoveryHandlers && !isLinearRethrowHandler(code, entry)) {
          kept.push(entry);
          continue;
        }
        changed = true;
        removals.push({
          className,
          methodName: method.name,
          descriptor: method.descriptor,
          startLabel: entry.startLbl || entry.startLabel || entry.start,
          endLabel: entry.endLbl || entry.endLabel || entry.end,
          handlerLabel: entry.handlerLbl || entry.handlerLabel || entry.handler,
        });
      }
      if (kept.length !== code.exceptionTable.length) {
        code.exceptionTable = kept;
        if (!keepHandlerCode) removeNowUnreferencedBareAthrowBlocks(code);
      }
    }
  }

  return { changed, removals };
}

function isLinearRethrowHandler(code, entry) {
  const handlerLabel = trimLabel(entry.handlerLbl || entry.handlerLabel || entry.handler);
  const items = code.codeItems || [];
  const start = items.findIndex((item) => trimLabel(item && item.labelDef) === handlerLabel);
  if (start < 0) return false;

  for (let i = start; i < items.length; i += 1) {
    const instructionOp = op(items[i]);
    if (!instructionOp) continue;
    if (instructionOp === 'athrow') return true;
    if (instructionOp === 'goto' || instructionOp === 'goto_w' || instructionOp === 'jsr' ||
        instructionOp === 'ret' || instructionOp.startsWith('if') ||
        instructionOp === 'tableswitch' || instructionOp === 'lookupswitch' ||
        instructionOp.endsWith('return')) {
      return false;
    }
  }
  return false;
}

function catchType(entry) {
  const value = entry && (entry.catch_type || entry.catchType || entry.type || entry.catchClass);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[value.length - 1];
  if (value && typeof value === 'object') return value.name || value.className || null;
  return null;
}

function removeNowUnreferencedBareAthrowBlocks(code) {
  const items = code.codeItems || [];
  const referenced = referencedLabels(code);
  for (let i = 0; i < items.length; i += 1) {
    const label = trimLabel(items[i] && items[i].labelDef);
    if (!label || referenced.has(label)) continue;
    const next = nextInstructionIndex(items, i - 1);
    if (next !== i || op(items[i]) !== 'athrow') continue;
    const after = nextInstructionIndex(items, i);
    if (after >= 0 && !items[after].labelDef) continue;
    delete items[i].instruction;
    delete items[i].pc;
  }
}

function referencedLabels(code) {
  const out = new Set();
  for (const entry of code.exceptionTable || []) {
    for (const label of [entry.startLbl, entry.startLabel, entry.endLbl, entry.endLabel, entry.handlerLbl, entry.handlerLabel]) {
      const normalized = trimLabel(label);
      if (normalized) out.add(normalized);
    }
  }
  for (const item of code.codeItems || []) {
    collectLabels(item && item.instruction, out);
  }
  return out;
}

function collectLabels(value, out) {
  if (!value) return;
  if (typeof value === 'string') {
    const label = trimLabel(value);
    if (label && /^L/.test(label)) out.add(label);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectLabels(entry, out);
    return;
  }
  if (typeof value === 'object') {
    if (typeof value.arg === 'string') collectLabels(value.arg, out);
    if (value.op === 'tableswitch' || value.op === 'lookupswitch') {
      collectLabels(value.arg, out);
      collectLabels(value.labels, out);
      collectLabels(value.defaultLbl, out);
    }
  }
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

function trimLabel(label) {
  return typeof label === 'string' ? label.replace(/:$/, '') : null;
}

module.exports = {
  removeRuntimeExceptionHandlers,
  catchType,
};

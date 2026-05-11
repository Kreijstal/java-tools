'use strict';

const {
  getStackEffect,
  normalizeInstruction,
  parseLocalOperation,
} = require('../utils/instructionUtils');

const BRANCH_OPS = new Set([
  'ifeq', 'ifne', 'iflt', 'ifge', 'ifgt', 'ifle',
  'ifnull', 'ifnonnull',
  'if_icmpeq', 'if_icmpne', 'if_icmplt', 'if_icmpge', 'if_icmpgt', 'if_icmple',
  'if_acmpeq', 'if_acmpne',
  'goto', 'goto_w', 'jsr', 'jsr_w', 'tableswitch', 'lookupswitch',
]);

const TERMINATOR_OPS = new Set([
  'ret', 'return', 'ireturn', 'lreturn', 'freturn', 'dreturn', 'areturn', 'athrow',
]);

const INVOKE_OPS = new Set(['invokevirtual', 'invokespecial', 'invokestatic', 'invokeinterface', 'invokedynamic']);

const ARRAY_LOAD_OPS = new Set(['iaload', 'laload', 'faload', 'daload', 'aaload', 'baload', 'caload', 'saload']);
const ARRAY_STORE_OPS = new Set(['iastore', 'lastore', 'fastore', 'dastore', 'aastore', 'bastore', 'castore', 'sastore']);
const FIELD_OPS = new Set(['getstatic', 'putstatic', 'getfield', 'putfield']);

function analyzeRegion(code, startIdx, endIdx, options = {}) {
  const items = Array.isArray(code && code.codeItems) ? code.codeItems : [];
  const start = Math.max(0, startIdx | 0);
  const end = Math.min(items.length, endIdx | 0);
  if (end < start) {
    throw new Error(`invalid region range ${startIdx}..${endIdx}`);
  }

  const labelIndex = buildLabelIndex(items);
  const regionLabels = collectRegionLabels(items, start, end);
  const protectedLabels = collectProtectedLabels(code && code.exceptionTable, items);
  const written = new Set();
  const read = new Set();
  const readBeforeWrite = new Set();
  const writtenAndLiveOut = new Set();
  const branchTargets = [];
  const localBranches = [];
  const outboundBranches = [];
  const inboundBranches = [];
  const reasons = [];
  const liveness = computeLocalLiveness(code);

  let stackDepth = 0;
  let maxStackDepth = 0;
  let minStackDepth = 0;
  let supported = true;
  let hasObservableSideEffects = false;
  let mayThrow = false;
  let hasControlFlow = false;
  let hasTerminator = false;
  let touchesProtectedLabel = false;
  let overlapsExceptionRange = false;

  for (let i = start; i < end; i += 1) {
    const item = items[i];
    if (!item) continue;
    const label = trimLabel(item.labelDef);
    if (label && protectedLabels.has(label)) {
      touchesProtectedLabel = true;
    }
    if (isPcInExceptionRange(item.pc, code && code.exceptionTable)) {
      overlapsExceptionRange = true;
    }
    if (!item.instruction) continue;

    const normalized = normalizeInstruction(item.instruction);
    const op = normalized && normalized.op;
    if (!op) {
      supported = false;
      reasons.push(`unsupported instruction at index ${i}`);
      continue;
    }

    const effect = getStackEffect(op, normalized);
    if (!effect) {
      supported = false;
      reasons.push(`unsupported opcode ${op} at index ${i}`);
      continue;
    }

    stackDepth -= effect.popSlots || 0;
    minStackDepth = Math.min(minStackDepth, stackDepth);
    stackDepth += effect.pushSlots || 0;
    maxStackDepth = Math.max(maxStackDepth, stackDepth);

    const local = parseLocalOperation(normalized, item.instruction);
    if (local && Number.isInteger(local.index)) {
      if (isLocalLoad(local.base)) {
        read.add(local.index);
        if (!written.has(local.index)) readBeforeWrite.add(local.index);
      } else if (isLocalStore(local.base)) {
        written.add(local.index);
      }
    }
    if (op === 'iinc') {
      const index = localIndexFromIinc(normalized);
      if (index !== null) {
        if (!written.has(index)) readBeforeWrite.add(index);
        read.add(index);
        written.add(index);
      }
    }

    const effects = classifyInstructionEffects(normalized);
    if (effects.hasObservableSideEffect) hasObservableSideEffects = true;
    if (effects.mayThrow) mayThrow = true;
    if (TERMINATOR_OPS.has(op)) hasTerminator = true;
    if (BRANCH_OPS.has(op) || TERMINATOR_OPS.has(op)) hasControlFlow = true;

    for (const target of getInstructionTargets(normalized)) {
      const targetLabel = trimLabel(target);
      if (!targetLabel) continue;
      const targetIdx = labelIndex.get(targetLabel);
      const entry = { fromIdx: i, target: targetLabel, targetIdx };
      branchTargets.push(entry);
      if (targetIdx != null && targetIdx >= start && targetIdx < end) {
        localBranches.push(entry);
      } else {
        outboundBranches.push(entry);
      }
    }
  }

  for (let i = 0; i < items.length; i += 1) {
    if (i >= start && i < end) continue;
    const item = items[i];
    if (!item || !item.instruction) continue;
    const normalized = normalizeInstruction(item.instruction);
    for (const target of getInstructionTargets(normalized)) {
      const targetLabel = trimLabel(target);
      if (targetLabel && regionLabels.has(targetLabel)) {
        inboundBranches.push({ fromIdx: i, target: targetLabel, targetIdx: labelIndex.get(targetLabel) });
      }
    }
  }

  const liveIn = liveness.liveIn[start] ? new Set(liveness.liveIn[start]) : new Set();
  const liveOut = computeRegionLiveOut(items, start, end, liveness, labelIndex, outboundBranches);

  for (const local of written) {
    if (liveOut.has(local)) writtenAndLiveOut.add(local);
  }

  return {
    start,
    end,
    instructionCount: countInstructions(items, start, end),
    labels: regionLabels,
    protectedLabels,
    touchesProtectedLabel,
    overlapsExceptionRange,
    read,
    written,
    readBeforeWrite,
    writtenAndLiveOut,
    liveIn,
    liveOut,
    branchTargets,
    localBranches,
    outboundBranches,
    inboundBranches,
    stack: {
      delta: stackDepth,
      maxDepth: maxStackDepth,
      minDepth: minStackDepth,
      underflowsEntry: minStackDepth < 0,
    },
    supported,
    hasControlFlow,
    hasTerminator,
    hasObservableSideEffects,
    mayThrow,
    reasons,
  };
}

function canDuplicateRegion(code, startIdx, endIdx, options = {}) {
  const summary = analyzeRegion(code, startIdx, endIdx, options);
  const reasons = [...summary.reasons];
  const allowControlFlow = !!options.allowControlFlow;
  const allowLocalBranches = !!options.allowLocalBranches;
  const allowMayThrow = !!options.allowMayThrow;
  const allowSideEffects = !!options.allowSideEffects;
  const requireStackNeutral = !!options.requireStackNeutral;

  if (!summary.supported) reasons.push('region contains unsupported instructions');
  if (summary.touchesProtectedLabel || summary.overlapsExceptionRange) {
    reasons.push('region touches exception-protected code');
  }
  if (summary.inboundBranches.length > 0) reasons.push('region has external branch entries');
  if (!allowControlFlow && summary.hasControlFlow) reasons.push('region contains control flow');
  if (allowControlFlow && !allowLocalBranches && summary.localBranches.length > 0) {
    reasons.push('region contains local branches');
  }
  if (summary.outboundBranches.length > 0) reasons.push('region branches outside the region');
  if (!allowSideEffects && summary.hasObservableSideEffects) {
    reasons.push('region has observable side effects');
  }
  if (!allowMayThrow && summary.mayThrow) reasons.push('region may throw');
  if (requireStackNeutral && summary.stack.delta !== 0) {
    reasons.push(`region stack delta is ${summary.stack.delta}`);
  }

  return {
    ok: reasons.length === 0,
    reasons,
    summary,
  };
}

function classifyInstructionEffects(instruction) {
  const normalized = normalizeInstruction(instruction);
  const op = normalized && normalized.op;
  if (!op) {
    return { hasObservableSideEffect: true, mayThrow: true };
  }

  if (INVOKE_OPS.has(op)) return { hasObservableSideEffect: true, mayThrow: true };
  if (op === 'putstatic' || op === 'putfield') return { hasObservableSideEffect: true, mayThrow: true };
  if (ARRAY_STORE_OPS.has(op)) return { hasObservableSideEffect: true, mayThrow: true };
  if (op === 'monitorenter' || op === 'monitorexit') return { hasObservableSideEffect: true, mayThrow: true };
  if (op === 'athrow') return { hasObservableSideEffect: true, mayThrow: true };
  if (op === 'new' || op === 'newarray' || op === 'anewarray' || op === 'multianewarray') {
    return { hasObservableSideEffect: true, mayThrow: true };
  }

  if (ARRAY_LOAD_OPS.has(op)) return { hasObservableSideEffect: false, mayThrow: true };
  if (op === 'getfield' || op === 'arraylength' || op === 'checkcast') {
    return { hasObservableSideEffect: false, mayThrow: true };
  }
  if (op === 'idiv' || op === 'irem' || op === 'ldiv' || op === 'lrem') {
    return { hasObservableSideEffect: false, mayThrow: true };
  }
  if (FIELD_OPS.has(op)) {
    return { hasObservableSideEffect: false, mayThrow: op === 'getstatic' };
  }
  return { hasObservableSideEffect: false, mayThrow: false };
}

function computeLocalLiveness(code) {
  const items = Array.isArray(code && code.codeItems) ? code.codeItems : [];
  const labelIndex = buildLabelIndex(items);
  const pcIndex = buildPcIndex(items);
  const exceptionSuccessors = buildExceptionSuccessors(items, code && code.exceptionTable, pcIndex);
  const liveIn = Array.from({ length: items.length + 1 }, () => new Set());
  const liveOut = Array.from({ length: items.length + 1 }, () => new Set());
  const uses = [];
  const defs = [];
  const successors = [];

  for (let i = 0; i < items.length; i += 1) {
    const access = localAccess(items[i] && items[i].instruction);
    uses[i] = access.uses;
    defs[i] = access.defs;
    successors[i] = instructionSuccessors(items, i, labelIndex);
    const handlers = exceptionSuccessors.get(i);
    if (handlers) successors[i].push(...handlers);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const nextOut = new Set();
      for (const successor of successors[i]) {
        if (successor >= 0 && successor < liveIn.length) {
          unionInto(nextOut, liveIn[successor]);
        }
      }

      const nextIn = new Set(uses[i]);
      for (const local of nextOut) {
        if (!defs[i].has(local)) nextIn.add(local);
      }

      if (!setEquals(liveOut[i], nextOut)) {
        liveOut[i] = nextOut;
        changed = true;
      }
      if (!setEquals(liveIn[i], nextIn)) {
        liveIn[i] = nextIn;
        changed = true;
      }
    }
  }

  return { liveIn, liveOut, successors, uses, defs };
}

function getLocalLivenessAt(code, idx) {
  const liveness = computeLocalLiveness(code);
  const index = Math.max(0, Math.min(idx | 0, liveness.liveIn.length - 1));
  return {
    liveIn: new Set(liveness.liveIn[index]),
    liveOut: new Set(liveness.liveOut[index]),
  };
}

function compareLiveInLocals(code, leftIdx, rightIdx) {
  const liveness = computeLocalLiveness(code);
  const left = new Set(liveness.liveIn[Math.max(0, Math.min(leftIdx | 0, liveness.liveIn.length - 1))]);
  const right = new Set(liveness.liveIn[Math.max(0, Math.min(rightIdx | 0, liveness.liveIn.length - 1))]);
  return {
    ok: setEquals(left, right),
    left,
    right,
    onlyLeft: setDifference(left, right),
    onlyRight: setDifference(right, left),
  };
}

function regionPreservesLiveOut(code, startIdx, endIdx) {
  const summary = analyzeRegion(code, startIdx, endIdx);
  const clobbered = intersection(summary.written, summary.liveOut);
  return {
    ok: clobbered.size === 0,
    clobbered,
    summary,
  };
}

function computeRegionLiveOut(items, start, end, liveness, labelIndex, outboundBranches) {
  const out = new Set();
  for (const branch of outboundBranches) {
    if (branch.targetIdx != null) unionInto(out, liveness.liveIn[branch.targetIdx]);
  }

  const lastInstruction = previousInstructionIndex(items, end - 1, start);
  const lastOp = lastInstruction == null ? null : getOpcode(items[lastInstruction].instruction);
  if (end < items.length && (lastInstruction == null || instructionMayFallThrough(lastOp))) {
    unionInto(out, liveness.liveIn[end]);
  }
  return out;
}

function instructionSuccessors(items, idx, labelIndex) {
  const item = items[idx];
  const next = nextInstructionIndex(items, idx + 1);
  if (!item || !item.instruction) return next == null ? [] : [next];

  const normalized = normalizeInstruction(item.instruction);
  const op = normalized && normalized.op;
  if (!op) return next == null ? [] : [next];

  if (TERMINATOR_OPS.has(op) || op === 'ret') return [];

  const targets = getInstructionTargets(normalized)
    .map((target) => labelIndex.get(trimLabel(target)))
    .filter((targetIdx) => targetIdx != null);

  if (op === 'goto' || op === 'goto_w' || op === 'jsr' || op === 'jsr_w') return targets;
  if (op === 'tableswitch' || op === 'lookupswitch') return targets;
  if (BRANCH_OPS.has(op)) {
    const out = [...targets];
    if (next != null) out.push(next);
    return out;
  }
  return next == null ? [] : [next];
}

function localAccess(instruction) {
  const uses = new Set();
  const defs = new Set();
  const normalized = normalizeInstruction(instruction);
  if (!normalized || !normalized.op) return { uses, defs };

  if (normalized.op === 'iinc') {
    const index = localIndexFromIinc(normalized);
    if (index != null) {
      uses.add(index);
      defs.add(index);
    }
    return { uses, defs };
  }

  const local = parseLocalOperation(normalized, instruction);
  if (!local || !Number.isInteger(local.index)) return { uses, defs };
  if (isLocalLoad(local.base)) uses.add(local.index);
  else if (isLocalStore(local.base)) defs.add(local.index);
  return { uses, defs };
}

function buildPcIndex(items) {
  const out = new Map();
  for (let i = 0; i < items.length; i += 1) {
    if (typeof (items[i] && items[i].pc) === 'number') out.set(items[i].pc, i);
  }
  return out;
}

function buildExceptionSuccessors(items, exceptionTable = [], pcIndex = new Map()) {
  const out = new Map();
  for (const entry of exceptionTable || []) {
    const handlerIdx = pcIndex.get(entry && entry.handler_pc);
    if (handlerIdx == null) continue;
    for (let i = 0; i < items.length; i += 1) {
      const pc = items[i] && items[i].pc;
      if (
        typeof pc === 'number' &&
        typeof entry.start_pc === 'number' &&
        typeof entry.end_pc === 'number' &&
        pc >= entry.start_pc &&
        pc < entry.end_pc
      ) {
        if (!out.has(i)) out.set(i, []);
        out.get(i).push(handlerIdx);
      }
    }
  }
  return out;
}

function nextInstructionIndex(items, start) {
  for (let i = start; i < items.length; i += 1) {
    if (items[i] && items[i].instruction) return i;
  }
  return null;
}

function previousInstructionIndex(items, start, floor = 0) {
  for (let i = start; i >= floor; i -= 1) {
    if (items[i] && items[i].instruction) return i;
  }
  return null;
}

function instructionMayFallThrough(op) {
  if (!op) return true;
  if (TERMINATOR_OPS.has(op)) return false;
  return !(op === 'goto' || op === 'goto_w' || op === 'tableswitch' || op === 'lookupswitch');
}

function getOpcode(instruction) {
  const normalized = normalizeInstruction(instruction);
  return normalized && normalized.op;
}

function unionInto(target, source) {
  if (!source) return;
  for (const value of source) target.add(value);
}

function setEquals(a, b) {
  if (a === b) return true;
  if (!a || !b || a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

function setDifference(left, right) {
  const out = new Set();
  for (const value of left || []) {
    if (!right || !right.has(value)) out.add(value);
  }
  return out;
}

function intersection(left, right) {
  const out = new Set();
  for (const value of left || []) {
    if (right && right.has(value)) out.add(value);
  }
  return out;
}

function buildLabelIndex(items) {
  const out = new Map();
  for (let i = 0; i < items.length; i += 1) {
    const label = trimLabel(items[i] && items[i].labelDef);
    if (label) out.set(label, i);
  }
  return out;
}

function collectRegionLabels(items, start, end) {
  const out = new Set();
  for (let i = start; i < end; i += 1) {
    const label = trimLabel(items[i] && items[i].labelDef);
    if (label) out.add(label);
  }
  return out;
}

function collectProtectedLabels(exceptionTable = [], items = []) {
  const byPc = new Map();
  for (const item of items) {
    const label = trimLabel(item && item.labelDef);
    if (label && typeof item.pc === 'number') byPc.set(item.pc, label);
  }
  const out = new Set();
  for (const entry of exceptionTable || []) {
    for (const key of ['startLbl', 'startLabel', 'start', 'endLbl', 'endLabel', 'end', 'handlerLbl', 'handlerLabel', 'handler', 'usingLbl']) {
      const label = trimLabel(entry && entry[key]);
      if (label) out.add(label);
    }
    for (const key of ['start_pc', 'end_pc', 'handler_pc']) {
      const label = byPc.get(entry && entry[key]);
      if (label) out.add(label);
    }
  }
  return out;
}

function getInstructionTargets(instruction) {
  const normalized = normalizeInstruction(instruction);
  if (!normalized || !normalized.op) return [];
  const op = normalized.op;
  if (op === 'tableswitch') {
    const labels = [];
    if (Array.isArray(normalized.labels)) labels.push(...normalized.labels);
    if (normalized.defaultLbl) labels.push(normalized.defaultLbl);
    if (normalized.defaultLabel) labels.push(normalized.defaultLabel);
    return labels;
  }
  if (op === 'lookupswitch') {
    const labels = [];
    const arg = normalized.arg || {};
    if (Array.isArray(arg.pairs)) {
      for (const pair of arg.pairs) {
        if (Array.isArray(pair) && pair[1]) labels.push(pair[1]);
      }
    }
    if (arg.defaultLabel) labels.push(arg.defaultLabel);
    if (arg.defaultLbl) labels.push(arg.defaultLbl);
    return labels;
  }
  if (BRANCH_OPS.has(op) && typeof normalized.arg === 'string') return [normalized.arg];
  return [];
}

function isPcInExceptionRange(pc, exceptionTable = []) {
  if (typeof pc !== 'number') return false;
  return (exceptionTable || []).some((entry) => (
    typeof entry.start_pc === 'number' &&
    typeof entry.end_pc === 'number' &&
    pc >= entry.start_pc &&
    pc < entry.end_pc
  ));
}

function countInstructions(items, start, end) {
  let count = 0;
  for (let i = start; i < end; i += 1) {
    if (items[i] && items[i].instruction) count += 1;
  }
  return count;
}

function isLocalLoad(base) {
  return base === 'iload' || base === 'lload' || base === 'fload' || base === 'dload' || base === 'aload';
}

function isLocalStore(base) {
  return base === 'istore' || base === 'lstore' || base === 'fstore' || base === 'dstore' || base === 'astore';
}

function localIndexFromIinc(normalized) {
  const raw = normalized.varnum ?? normalized.index ?? normalized.arg;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) ? value : null;
}

function isLocalReadBeforeWrite(items, startIdx, local) {
  for (let i = startIdx; i < items.length; i += 1) {
    const item = items[i];
    if (!item || !item.instruction) continue;
    const normalized = normalizeInstruction(item.instruction);
    if (!normalized) continue;
    if (normalized.op === 'iinc') {
      const index = localIndexFromIinc(normalized);
      if (index === local) return true;
    }
    const op = parseLocalOperation(normalized, item.instruction);
    if (!op || op.index !== local) continue;
    if (isLocalLoad(op.base)) return true;
    if (isLocalStore(op.base)) return false;
  }
  return false;
}

function trimLabel(value) {
  if (typeof value !== 'string') return null;
  return value.endsWith(':') ? value.slice(0, -1) : value;
}

module.exports = {
  analyzeRegion,
  canDuplicateRegion,
  classifyInstructionEffects,
  collectProtectedLabels,
  compareLiveInLocals,
  computeLocalLiveness,
  getLocalLivenessAt,
  getInstructionTargets,
  regionPreservesLiveOut,
};

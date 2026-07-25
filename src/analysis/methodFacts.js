'use strict';

function createMethodFacts(code, hooks = {}) {
  return new MethodFacts(code, hooks);
}

class MethodFacts {
  constructor(code, hooks = {}) {
    this.code = code;
    this.hooks = hooks;
    this.invalidate();
  }

  invalidate() {
    this._labelIndex = null;
    this._pcIndex = null;
    this._pcLabelIndex = null;
    this._refCounts = null;
    this._branchRefsByLabel = null;
    this._suffixInstructionCounts = null;
    this._terminalPrefixCounts = null;
    this._regionSummaries = new Map();
    this._protectedRanges = new Map();
  }

  codeItems() {
    return this.code && Array.isArray(this.code.codeItems) ? this.code.codeItems : [];
  }

  labelIndex() {
    if (!this._labelIndex) this._labelIndex = buildLabelIndex(this.codeItems());
    return this._labelIndex;
  }

  pcIndex() {
    if (!this._pcIndex) this._pcIndex = buildPcIndex(this.codeItems());
    return this._pcIndex;
  }

  pcLabelIndex() {
    if (!this._pcLabelIndex) this._pcLabelIndex = buildPcLabelIndex(this.codeItems());
    return this._pcLabelIndex;
  }

  instructionLabelReferenceCounts() {
    if (!this._refCounts) this._refCounts = collectInstructionLabelReferenceCounts(this.codeItems());
    return this._refCounts;
  }

  branchRefsByLabel() {
    if (!this._branchRefsByLabel) this._branchRefsByLabel = collectBranchRefsByLabel(this.codeItems());
    return this._branchRefsByLabel;
  }

  suffixInstructionCounts() {
    if (!this._suffixInstructionCounts) this._suffixInstructionCounts = buildSuffixInstructionCounts(this.codeItems());
    return this._suffixInstructionCounts;
  }

  terminalPrefixCounts() {
    if (!this._terminalPrefixCounts) {
      this._terminalPrefixCounts = buildTerminalPrefixCounts(this.codeItems(), this.hooks);
    }
    return this._terminalPrefixCounts;
  }

  countInstructions(startIdx, endIdx) {
    const counts = this.suffixInstructionCounts();
    return counts[startIdx] - counts[endIdx];
  }

  rangeContainsTerminal(startIdx, endIdx) {
    const counts = this.terminalPrefixCounts();
    return counts[endIdx] - counts[startIdx] > 0;
  }

  analyzeRegion(startIdx, endIdx, options = {}) {
    if (!this.hooks.analyzeRegion) {
      throw new Error('MethodFacts.analyzeRegion requires an analyzeRegion hook');
    }
    const key = `${startIdx}:${endIdx}:${options.allowControlFlow ? 1 : 0}:${options.allowSideEffects ? 1 : 0}`;
    if (!this._regionSummaries.has(key)) {
      this._regionSummaries.set(key, this.hooks.analyzeRegion(this.code, startIdx, endIdx, options));
    }
    return this._regionSummaries.get(key);
  }

  regionTouchesProtectedLabel(startIdx, endIdx) {
    if (!this.hooks.regionTouchesProtectedLabel) {
      throw new Error('MethodFacts.regionTouchesProtectedLabel requires a regionTouchesProtectedLabel hook');
    }
    const key = `${startIdx}:${endIdx}`;
    if (!this._protectedRanges.has(key)) {
      this._protectedRanges.set(key, this.hooks.regionTouchesProtectedLabel(this.code, startIdx, endIdx));
    }
    return this._protectedRanges.get(key);
  }
}

function buildLabelIndex(codeItems) {
  const out = new Map();
  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (item && item.labelDef) out.set(trimLabel(item.labelDef), i);
  }
  return out;
}

function buildPcIndex(codeItems) {
  const out = new Map();
  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (item && typeof item.pc === 'number') out.set(item.pc, i);
  }
  return out;
}

function buildPcLabelIndex(codeItems) {
  const out = new Map();
  for (const item of codeItems) {
    if (item && typeof item.pc === 'number' && item.labelDef) {
      out.set(item.pc, trimLabel(item.labelDef));
    }
  }
  return out;
}

function collectInstructionLabelReferenceCounts(codeItems) {
  const counts = new Map();
  for (const item of codeItems) {
    collectInstructionLabels(item && item.instruction, {
      add(label) {
        const normalized = trimLabel(label);
        if (!normalized) return;
        counts.set(normalized, (counts.get(normalized) || 0) + 1);
      },
    });
  }
  return counts;
}

function collectBranchRefsByLabel(codeItems) {
  const out = new Map();
  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (!item || !item.instruction) continue;
    const arg = getInstructionArg(item.instruction);
    if (typeof arg !== 'string') continue;
    const label = trimLabel(arg);
    if (!label) continue;
    let refs = out.get(label);
    if (!refs) {
      refs = [];
      out.set(label, refs);
    }
    refs.push({ idx: i, item });
  }
  return out;
}

function buildSuffixInstructionCounts(codeItems) {
  const counts = new Array(codeItems.length + 1);
  counts[codeItems.length] = 0;
  for (let i = codeItems.length - 1; i >= 0; i -= 1) {
    counts[i] = counts[i + 1] + (codeItems[i] && codeItems[i].instruction ? 1 : 0);
  }
  return counts;
}

function buildTerminalPrefixCounts(codeItems, hooks) {
  const counts = new Array(codeItems.length + 1);
  counts[0] = 0;
  const opcodeOf = hooks.opcodeMnemonic || opcodeMnemonic;
  const terminal = hooks.isTerminalOpcode || (() => false);
  for (let i = 0; i < codeItems.length; i += 1) {
    const opcode = opcodeOf(codeItems[i] && codeItems[i].instruction);
    counts[i + 1] = counts[i] + (terminal(opcode) ? 1 : 0);
  }
  return counts;
}

function collectInstructionLabels(instruction, out) {
  if (!instruction) return;
  const arg = getInstructionArg(instruction);
  if (typeof arg === 'string') {
    out.add(arg);
  } else if (Array.isArray(arg)) {
    for (const entry of arg) collectLabelsInValue(entry, out);
  } else if (arg && typeof arg === 'object') {
    collectLabelsInValue(arg, out);
  }
}

function collectLabelsInValue(value, out) {
  if (typeof value === 'string') {
    out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectLabelsInValue(item, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectLabelsInValue(item, out);
  }
}

function getInstructionArg(instruction) {
  if (!instruction) return null;
  if (typeof instruction === 'string') {
    const parts = instruction.trim().split(/\s+/);
    if (!isBranchOpcode(parts[0])) return null;
    return parts.length > 1 ? parts[1] : null;
  }
  return instruction.arg == null ? null : instruction.arg;
}

function isBranchOpcode(opcode) {
  return opcode === 'goto' || opcode === 'goto_w' || opcode === 'jsr' || opcode === 'jsr_w' ||
    /^if/.test(opcode || '');
}

function opcodeMnemonic(instruction) {
  if (!instruction) return null;
  if (typeof instruction === 'string') return instruction.trim().split(/\s+/)[0] || null;
  return instruction.op || instruction.opcode || null;
}

function trimLabel(label) {
  if (label == null) return null;
  return String(label).replace(/:$/, '');
}

module.exports = {
  MethodFacts,
  createMethodFacts,
};

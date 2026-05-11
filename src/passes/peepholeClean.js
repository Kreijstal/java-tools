'use strict';

const { removeTrivialRethrowHandlers } = require('./removeTrivialRethrowHandlers');

function runPeepholeClean(astRoot, options = {}) {
  let changes = 0;
  const details = {
    rethrowHandlers: 0,
    nops: 0,
    threadedBranches: 0,
    invertedFallthroughGotos: 0,
    fallthroughGotos: 0,
    unreachableInstructions: 0,
    unusedLabels: 0,
  };

  if (options.removeRethrowHandlers !== false) {
    const rethrow = removeTrivialRethrowHandlers(astRoot, {
      removeHandlerCode: options.removeHandlerCode !== false,
    });
    if (rethrow.changed) {
      details.rethrowHandlers = rethrow.removals.length;
      changes += rethrow.removals.length;
    }
  }

  for (let i = 0; i < 4; i += 1) {
    const round = cleanOneRound(astRoot, {
      removeUnreachableCode: options.removeHandlerCode !== false,
    });
    details.nops += round.nops;
    details.threadedBranches += round.threadedBranches;
    details.invertedFallthroughGotos += round.invertedFallthroughGotos;
    details.fallthroughGotos += round.fallthroughGotos;
    details.unreachableInstructions += round.unreachableInstructions;
    details.unusedLabels += round.unusedLabels;
    changes += round.nops + round.threadedBranches + round.invertedFallthroughGotos + round.fallthroughGotos +
      round.unreachableInstructions + round.unusedLabels;
    if (
      round.nops + round.threadedBranches + round.invertedFallthroughGotos + round.fallthroughGotos +
      round.unreachableInstructions + round.unusedLabels === 0
    ) {
      break;
    }
  }

  return { changed: changes > 0, changes, details };
}

function cleanOneRound(astRoot, options = {}) {
  const details = {
    nops: 0,
    threadedBranches: 0,
    invertedFallthroughGotos: 0,
    fallthroughGotos: 0,
    unreachableInstructions: 0,
    unusedLabels: 0,
  };
  forEachCode(astRoot, (code, method) => {
    details.nops += removeNops(code.codeItems);
    details.threadedBranches += threadBranchesThroughGoto(code.codeItems);
    if (method && method.name === '<init>') {
      details.invertedFallthroughGotos += invertConditionalOverGoto(code);
      details.unreachableInstructions += removeUnreachableUntilUsedLabel(code);
    }
    details.fallthroughGotos += removeSingleUseFallthroughGotos(code);
    if (options.removeUnreachableCode !== false) {
      details.unreachableInstructions += removeUnreachableAfterTerminal(code);
    }
    details.unusedLabels += removeUnusedLabels(code);
  });
  return details;
}

function forEachCode(astRoot, fn) {
  for (const classItem of astRoot.classes || []) {
    for (const item of classItem.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      for (const attr of item.method.attributes || []) {
        if (attr && attr.type === 'code' && attr.code && Array.isArray(attr.code.codeItems)) {
          fn(attr.code, item.method, classItem);
        }
      }
    }
  }
}

function removeNops(codeItems) {
  let removed = 0;
  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (!item || !item.instruction || getOpcode(item.instruction) !== 'nop') continue;
    removeInstructionOnly(codeItems, i);
    removed += 1;
    if (!codeItems[i] || !codeItems[i].instruction) {
      i -= 1;
    }
  }
  return removed;
}

function threadBranchesThroughGoto(codeItems) {
  let changed = 0;
  const labelIndex = buildLabelIndex(codeItems);
  for (const item of codeItems) {
    if (!item || !item.instruction || !isConditionalBranch(getOpcode(item.instruction))) continue;
    const target = trimLabel(getInstructionArg(item.instruction));
    if (!target) continue;
    if (countInstructionLabelReferences(codeItems, target) !== 1) continue;
    if (hasFallthroughPredecessor(codeItems, labelIndex, target)) continue;
    const bridge = firstInstructionAtLabel(codeItems, labelIndex, target);
    if (!bridge || getOpcode(bridge.instruction) !== 'goto') continue;
    const nextTarget = trimLabel(getInstructionArg(bridge.instruction));
    if (!nextTarget || nextTarget === target) continue;
    item.instruction = setInstructionArg(item.instruction, nextTarget);
    changed += 1;
  }
  return changed;
}

function removeSingleUseFallthroughGotos(code) {
  let removed = 0;
  const codeItems = code.codeItems;
  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (!item || !item.instruction || getOpcode(item.instruction) !== 'goto') continue;
    const target = trimLabel(getInstructionArg(item.instruction));
    if (!target) continue;
    const nextLabel = findNextLabel(codeItems, i + 1);
    if (target !== nextLabel) continue;
    if (isLabelProtected(code, target)) continue;
    if (countInstructionLabelReferences(codeItems, target) !== 1) continue;
    removeInstructionOnly(codeItems, i);
    removed += 1;
    if (!codeItems[i] || !codeItems[i].instruction) {
      i -= 1;
    }
  }
  return removed;
}

function invertConditionalOverGoto(code) {
  let changed = 0;
  const codeItems = code.codeItems;
  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    const opcode = getOpcode(item && item.instruction);
    const inverse = INVERSE_CONDITIONALS[opcode];
    if (!inverse) continue;
    const bodyLabel = trimLabel(getInstructionArg(item.instruction));
    if (!bodyLabel) continue;
    const gotoIndex = nextInstructionIndex(codeItems, i + 1);
    if (gotoIndex == null || getOpcode(codeItems[gotoIndex] && codeItems[gotoIndex].instruction) !== 'goto') continue;
    const exitLabel = trimLabel(getInstructionArg(codeItems[gotoIndex].instruction));
    if (!exitLabel || exitLabel === bodyLabel) continue;
    if (findNextLabel(codeItems, gotoIndex + 1) !== bodyLabel) continue;
    if (isLabelProtected(code, bodyLabel) || isLabelProtected(code, exitLabel)) continue;
    item.instruction = { op: inverse, arg: exitLabel };
    removeInstructionOnly(codeItems, gotoIndex);
    changed += 1;
  }
  return changed;
}

function removeUnreachableAfterTerminal(code) {
  const codeItems = code.codeItems;
  const used = collectControlFlowLabels(code);
  const labelIndex = buildLabelIndex(codeItems);
  let removed = 0;

  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (!item || !item.instruction || !isTerminalOpcode(getOpcode(item.instruction))) continue;
    const dead = collectTrailingDeadBackedge(codeItems, used, labelIndex, i + 1, i);
    if (!dead) continue;
    for (let j = dead.end; j >= dead.start; j -= 1) {
      if (codeItems[j] && codeItems[j].instruction) removed += 1;
      codeItems.splice(j, 1);
    }
  }

  return removed;
}

function removeUnreachableUntilUsedLabel(code) {
  const codeItems = code.codeItems;
  const used = collectControlFlowLabels(code);
  let removed = 0;
  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (!item || !item.instruction || !isTerminalOpcode(getOpcode(item.instruction))) continue;
    let end = i;
    for (let j = i + 1; j < codeItems.length; j += 1) {
      const next = codeItems[j];
      if (next && next.labelDef && used.has(trimLabel(next.labelDef))) break;
      end = j;
    }
    if (end <= i) continue;
    for (let j = end; j > i; j -= 1) {
      if (codeItems[j] && codeItems[j].instruction) removed += 1;
      codeItems.splice(j, 1);
    }
  }
  return removed;
}

function collectTrailingDeadBackedge(codeItems, usedLabels, labelIndex, start, terminalIndex) {
  let gotoCount = 0;
  let end = start - 1;

  for (let i = start; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (!item) continue;
    if (item.labelDef && usedLabels.has(trimLabel(item.labelDef))) return null;
    if (!item.instruction) {
      end = i;
      continue;
    }
    const opcode = getOpcode(item.instruction);
    if (opcode !== 'goto' && opcode !== 'goto_w') return null;
    const target = trimLabel(getInstructionArg(item.instruction));
    const targetIndex = labelIndex.get(target);
    if (targetIndex == null || targetIndex >= terminalIndex) return null;
    gotoCount += 1;
    end = i;
  }

  return gotoCount === 1 ? { start, end } : null;
}

function collectControlFlowLabels(code) {
  const used = new Set();
  for (const entry of code.exceptionTable || []) {
    addLabel(used, entry.startLbl || entry.startLabel || entry.start);
    addLabel(used, entry.endLbl || entry.endLabel || entry.end);
    addLabel(used, entry.handlerLbl || entry.handlerLabel || entry.handler || entry.usingLbl);
  }
  for (const item of code.codeItems || []) {
    collectInstructionLabels(item && item.instruction, used);
  }
  return used;
}

function removeUnusedLabels(code) {
  const used = collectUsedLabels(code);
  let removed = 0;
  const codeItems = code.codeItems;
  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (!item || !item.labelDef) continue;
    const label = trimLabel(item.labelDef);
    if (used.has(label)) continue;
    delete item.labelDef;
    removed += 1;
    if (!item.instruction && !item.stackMapFrame && !item.pc) {
      codeItems.splice(i, 1);
      i -= 1;
    }
  }
  return removed;
}

function collectUsedLabels(code) {
  const used = new Set();
  for (const entry of code.exceptionTable || []) {
    addLabel(used, entry.startLbl || entry.startLabel || entry.start);
    addLabel(used, entry.endLbl || entry.endLabel || entry.end);
    addLabel(used, entry.handlerLbl || entry.handlerLabel || entry.handler || entry.usingLbl);
  }
  for (const item of code.codeItems || []) {
    if (item && item.stackMapFrame && item.labelDef) {
      addLabel(used, item.labelDef);
    }
    if (item && item.lineNumber && item.lineNumber.start) {
      addLabel(used, item.lineNumber.start);
    }
    collectInstructionLabels(item && item.instruction, used);
  }
  return used;
}

function buildLabelIndex(codeItems) {
  const out = new Map();
  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (item && item.labelDef) out.set(trimLabel(item.labelDef), i);
  }
  return out;
}

function firstInstructionAtLabel(codeItems, labelIndex, label) {
  const start = labelIndex.get(trimLabel(label));
  if (start == null) return null;
  for (let i = start; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (i !== start && item && item.labelDef) return null;
    if (item && item.instruction) return item;
  }
  return null;
}

function hasFallthroughPredecessor(codeItems, labelIndex, label) {
  const targetIndex = labelIndex.get(trimLabel(label));
  if (targetIndex == null) return false;
  for (let i = targetIndex - 1; i >= 0; i -= 1) {
    const item = codeItems[i];
    if (!item || !item.instruction) continue;
    return !isTerminalOpcode(getOpcode(item.instruction));
  }
  return false;
}

function isConditionalBranch(opcode) {
  return /^if/.test(opcode || '');
}

function isTerminalOpcode(opcode) {
  return opcode === 'goto' || opcode === 'goto_w' ||
    opcode === 'return' || opcode === 'ireturn' || opcode === 'lreturn' ||
    opcode === 'freturn' || opcode === 'dreturn' || opcode === 'areturn' ||
    opcode === 'athrow' || opcode === 'tableswitch' || opcode === 'lookupswitch';
}

function countInstructionLabelReferences(codeItems, label) {
  let count = 0;
  for (const item of codeItems || []) {
    if (!item || !item.instruction) continue;
    count += countLabelInValue(item.instruction.arg, label);
  }
  return count;
}

function collectInstructionLabels(instruction, used) {
  if (!instruction || typeof instruction !== 'object') return;
  collectLabelsFromValue(instruction.arg, used);
}

function collectLabelsFromValue(value, used) {
  if (!value) return;
  if (typeof value === 'string') {
    addLabel(used, value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectLabelsFromValue(entry, used));
    return;
  }
  if (typeof value === 'object') {
    Object.values(value).forEach((entry) => collectLabelsFromValue(entry, used));
  }
}

function countLabelInValue(value, label) {
  if (!value) return 0;
  if (typeof value === 'string') {
    return trimLabel(value) === label ? 1 : 0;
  }
  if (Array.isArray(value)) {
    return value.reduce((sum, entry) => sum + countLabelInValue(entry, label), 0);
  }
  if (typeof value === 'object') {
    return Object.values(value).reduce((sum, entry) => sum + countLabelInValue(entry, label), 0);
  }
  return 0;
}

function isLabelProtected(code, label) {
  for (const entry of code.exceptionTable || []) {
    if (trimLabel(entry.startLbl || entry.startLabel || entry.start) === label) return true;
    if (trimLabel(entry.endLbl || entry.endLabel || entry.end) === label) return true;
    if (trimLabel(entry.handlerLbl || entry.handlerLabel || entry.handler || entry.usingLbl) === label) {
      return true;
    }
  }
  return false;
}

function removeInstructionOnly(codeItems, index) {
  const item = codeItems[index];
  if (!item) return;
  if (item.labelDef || item.stackMapFrame) {
    delete item.instruction;
    delete item.pc;
  } else {
    codeItems.splice(index, 1);
  }
}

function findNextLabel(codeItems, startIndex) {
  for (let i = startIndex; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (item && item.labelDef) return trimLabel(item.labelDef);
    if (item && item.instruction) return null;
  }
  return null;
}

function nextInstructionIndex(codeItems, startIndex) {
  for (let i = startIndex; i < codeItems.length; i += 1) {
    if (codeItems[i] && codeItems[i].instruction) return i;
  }
  return null;
}

function getInstructionArg(instruction) {
  return instruction && typeof instruction === 'object' ? instruction.arg : null;
}

function setInstructionArg(instruction, arg) {
  if (!instruction || typeof instruction !== 'object') return instruction;
  return { ...instruction, arg };
}

function addLabel(set, label) {
  if (typeof label === 'string') {
    set.add(trimLabel(label));
  }
}

function getOpcode(instruction) {
  if (!instruction) return null;
  if (typeof instruction === 'string') return instruction;
  return instruction.op || null;
}

function trimLabel(label) {
  if (typeof label !== 'string') return label;
  return label.endsWith(':') ? label.slice(0, -1) : label;
}

const INVERSE_CONDITIONALS = {
  ifeq: 'ifne',
  ifne: 'ifeq',
  iflt: 'ifge',
  ifge: 'iflt',
  ifgt: 'ifle',
  ifle: 'ifgt',
  if_icmpeq: 'if_icmpne',
  if_icmpne: 'if_icmpeq',
  if_icmplt: 'if_icmpge',
  if_icmpge: 'if_icmplt',
  if_icmpgt: 'if_icmple',
  if_icmple: 'if_icmpgt',
  if_acmpeq: 'if_acmpne',
  if_acmpne: 'if_acmpeq',
  ifnull: 'ifnonnull',
  ifnonnull: 'ifnull',
};

module.exports = {
  runPeepholeClean,
  removeNops,
  threadBranchesThroughGoto,
  invertConditionalOverGoto,
  removeUnreachableAfterTerminal,
  removeUnreachableUntilUsedLabel,
  removeSingleUseFallthroughGotos,
  removeUnusedLabels,
};

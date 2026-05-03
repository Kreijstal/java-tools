'use strict';

const { removeTrivialRethrowHandlers } = require('./removeTrivialRethrowHandlers');

function runPeepholeClean(astRoot, options = {}) {
  let changes = 0;
  const details = {
    rethrowHandlers: 0,
    nops: 0,
    fallthroughGotos: 0,
    unusedLabels: 0,
  };

  const rethrow = removeTrivialRethrowHandlers(astRoot, {
    removeHandlerCode: options.removeHandlerCode !== false,
  });
  if (rethrow.changed) {
    details.rethrowHandlers = rethrow.removals.length;
    changes += rethrow.removals.length;
  }

  for (let i = 0; i < 4; i += 1) {
    const round = cleanOneRound(astRoot);
    details.nops += round.nops;
    details.fallthroughGotos += round.fallthroughGotos;
    details.unusedLabels += round.unusedLabels;
    changes += round.nops + round.fallthroughGotos + round.unusedLabels;
    if (round.nops + round.fallthroughGotos + round.unusedLabels === 0) {
      break;
    }
  }

  return { changed: changes > 0, changes, details };
}

function cleanOneRound(astRoot) {
  const details = { nops: 0, fallthroughGotos: 0, unusedLabels: 0 };
  forEachCode(astRoot, (code) => {
    details.nops += removeNops(code.codeItems);
    details.fallthroughGotos += removeSingleUseFallthroughGotos(code);
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

function getInstructionArg(instruction) {
  return instruction && typeof instruction === 'object' ? instruction.arg : null;
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

module.exports = {
  runPeepholeClean,
  removeNops,
  removeSingleUseFallthroughGotos,
  removeUnusedLabels,
};

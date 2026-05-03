'use strict';

function removeTrivialRethrowHandlers(astRoot) {
  let changed = false;
  const removals = [];

  for (const classItem of astRoot.classes || []) {
    const className = classItem.className || 'UnknownClass';
    for (const item of classItem.items || []) {
      if (!item || item.type !== 'method' || !item.method) {
        continue;
      }
      const method = item.method;
      const result = removeFromMethod(method);
      if (result.changed) {
        changed = true;
        result.removals.forEach((removal) => {
          removals.push({
            className,
            methodName: method.name,
            descriptor: method.descriptor,
            ...removal,
          });
        });
      }
    }
  }

  return { changed, removals };
}

function removeFromMethod(method) {
  const codeAttr = (method.attributes || []).find((attr) => attr && attr.type === 'code');
  if (!codeAttr || !codeAttr.code || !Array.isArray(codeAttr.code.codeItems)) {
    return { changed: false, removals: [] };
  }

  const code = codeAttr.code;
  const exceptionTable = Array.isArray(code.exceptionTable) ? code.exceptionTable : [];
  if (!exceptionTable.length) {
    return { changed: false, removals: [] };
  }

  const labelIndex = buildLabelIndex(code.codeItems);
  const pcLabelIndex = buildPcLabelIndex(code.codeItems);
  const removableHandlers = new Set();
  const removableBlocks = new Map();
  const removals = [];

  for (const entry of exceptionTable) {
    const handlerLabel = resolveHandlerLabel(entry, pcLabelIndex);
    if (!handlerLabel || removableHandlers.has(handlerLabel)) {
      continue;
    }
    const block = getLabelBlock(code.codeItems, labelIndex, handlerLabel);
    if (!block || !isBareAthrowBlock(block.items)) {
      continue;
    }
    if (hasNormalReferencesToLabel(code.codeItems, handlerLabel, block.startIndex, block.endIndex)) {
      continue;
    }
    removableHandlers.add(handlerLabel);
    removableBlocks.set(handlerLabel, block);
  }

  if (!removableHandlers.size) {
    return { changed: false, removals: [] };
  }

  const filtered = [];
  for (const entry of exceptionTable) {
    const handlerLabel = resolveHandlerLabel(entry, pcLabelIndex);
    if (handlerLabel && removableHandlers.has(handlerLabel)) {
      removals.push({
        handlerLabel,
        startLabel: entry.startLbl || entry.startLabel || entry.start,
        endLabel: entry.endLbl || entry.endLabel || entry.end,
        catchType: entry.catch_type || entry.catchType || entry.type || null,
      });
      continue;
    }
    filtered.push(entry);
  }

  code.exceptionTable = filtered;
  removeDeadAthrowInstructions(code.codeItems, removableBlocks);
  const removedGotos = removeFallthroughGotos(code.codeItems);
  return { changed: filtered.length !== exceptionTable.length || removedGotos > 0, removals };
}

function buildLabelIndex(codeItems) {
  const index = new Map();
  codeItems.forEach((item, i) => {
    if (item && item.labelDef) {
      index.set(trimLabel(item.labelDef), i);
    }
  });
  return index;
}

function buildPcLabelIndex(codeItems) {
  const index = new Map();
  codeItems.forEach((item) => {
    if (item && typeof item.pc === 'number' && item.labelDef) {
      index.set(item.pc, trimLabel(item.labelDef));
    }
  });
  return index;
}

function resolveHandlerLabel(entry, pcLabelIndex) {
  const direct = entry.handlerLbl || entry.handlerLabel || entry.handler || entry.usingLbl;
  if (direct) {
    return trimLabel(direct);
  }
  if (typeof entry.handler_pc === 'number') {
    return pcLabelIndex.get(entry.handler_pc) || null;
  }
  return null;
}

function getLabelBlock(codeItems, labelIndex, label) {
  if (!labelIndex.has(label)) {
    return null;
  }
  const startIndex = labelIndex.get(label);
  let endIndex = startIndex + 1;
  while (endIndex < codeItems.length) {
    const item = codeItems[endIndex];
    if (item && item.labelDef) {
      break;
    }
    endIndex += 1;
  }
  return {
    startIndex,
    endIndex,
    items: codeItems.slice(startIndex, endIndex),
  };
}

function isBareAthrowBlock(items) {
  let athrowCount = 0;
  for (const item of items) {
    if (!item || !item.instruction) {
      continue;
    }
    const opcode = getOpcode(item.instruction);
    if (opcode !== 'athrow') {
      return false;
    }
    athrowCount += 1;
  }
  return athrowCount === 1;
}

function removeDeadAthrowInstructions(codeItems, removableBlocks) {
  const indexes = [];
  for (const block of removableBlocks.values()) {
    for (let i = block.startIndex; i < block.endIndex; i += 1) {
      const item = codeItems[i];
      if (item && item.instruction && getOpcode(item.instruction) === 'athrow') {
        indexes.push(i);
      }
    }
  }

  indexes.sort((a, b) => b - a);
  indexes.forEach((index) => {
    const item = codeItems[index];
    if (!item) {
      return;
    }
    if (item.labelDef || item.stackMapFrame) {
      delete item.instruction;
      delete item.pc;
    } else {
      codeItems.splice(index, 1);
    }
  });
}

function removeFallthroughGotos(codeItems) {
  let removed = 0;
  for (let i = 0; i < codeItems.length - 1; i += 1) {
    const item = codeItems[i];
    if (!item || !item.instruction || getOpcode(item.instruction) !== 'goto') {
      continue;
    }
    const target = item.instruction.arg;
    if (!target) {
      continue;
    }
    const nextLabel = findNextLabel(codeItems, i + 1);
    if (!nextLabel || trimLabel(target) !== nextLabel) {
      continue;
    }
    if (item.labelDef || item.stackMapFrame) {
      delete item.instruction;
      delete item.pc;
    } else {
      codeItems.splice(i, 1);
      i -= 1;
    }
    removed += 1;
  }
  return removed;
}

function findNextLabel(codeItems, startIndex) {
  for (let i = startIndex; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (item && item.labelDef) {
      return trimLabel(item.labelDef);
    }
    if (item && item.instruction) {
      return null;
    }
  }
  return null;
}

function hasNormalReferencesToLabel(codeItems, label, blockStart, blockEnd) {
  for (let i = 0; i < codeItems.length; i += 1) {
    if (i >= blockStart && i < blockEnd) {
      continue;
    }
    const item = codeItems[i];
    if (!item || !item.instruction) {
      continue;
    }
    if (instructionReferencesLabel(item.instruction, label)) {
      return true;
    }
  }
  return false;
}

function instructionReferencesLabel(instruction, label) {
  if (!instruction || typeof instruction !== 'object') {
    return false;
  }
  if (typeof instruction.arg === 'string' && trimLabel(instruction.arg) === label) {
    return true;
  }
  return containsLabel(instruction.arg, label);
}

function containsLabel(value, label) {
  if (!value) {
    return false;
  }
  if (typeof value === 'string') {
    return trimLabel(value) === label;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsLabel(entry, label));
  }
  if (typeof value === 'object') {
    return Object.values(value).some((entry) => containsLabel(entry, label));
  }
  return false;
}

function getOpcode(instruction) {
  if (!instruction) {
    return null;
  }
  if (typeof instruction === 'string') {
    return instruction;
  }
  return instruction.op || null;
}

function trimLabel(label) {
  if (typeof label !== 'string') {
    return label;
  }
  return label.endsWith(':') ? label.slice(0, -1) : label;
}

module.exports = {
  removeTrivialRethrowHandlers,
  removeFromMethod,
};

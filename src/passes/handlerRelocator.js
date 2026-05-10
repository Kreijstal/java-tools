'use strict';

function relocateTrivialHandlers(astRoot) {
  const relocations = [];
  let changed = false;

  for (const classItem of astRoot.classes || []) {
    const className = classItem.className || 'UnknownClass';
    for (const member of classItem.items || []) {
      if (!member || member.type !== 'method' || !member.method) continue;
      const method = member.method;
      const result = relocateInMethod(method);
      if (result.changed) {
        changed = true;
        result.labels.forEach((label) =>
          relocations.push({
            className,
            methodName: method.name,
            descriptor: method.descriptor,
            handlerLabel: label,
          }),
        );
      }
    }
  }

  return { changed, relocations };
}

function relocateInMethod(method) {
  const codeAttr = (method.attributes || []).find((attr) => attr.type === 'code');
  if (!codeAttr || !codeAttr.code || !Array.isArray(codeAttr.code.codeItems)) {
    return { changed: false, labels: [] };
  }
  const exceptionTable = codeAttr.code.exceptionTable || [];
  if (!exceptionTable.length) {
    return { changed: false, labels: [] };
  }

  let changed = false;
  const relocatedLabels = [];
  const processed = new Set();

  const rebuildLabelIndex = () => {
    const map = new Map();
    codeAttr.code.codeItems.forEach((item, idx) => {
      if (!item || !item.labelDef) return;
      map.set(trimLabel(item.labelDef), idx);
    });
    return map;
  };

  let labelIndex = rebuildLabelIndex();

  const handlerLabels = exceptionTable
    .map((entry) => resolveHandlerLabel(entry, codeAttr.code.codeItems))
    .filter(Boolean);

  handlerLabels.forEach((label) => {
    if (processed.has(label)) return;
    const moveResult = relocateHandlerLabel(label, codeAttr.code.codeItems, labelIndex);
    if (moveResult) {
      changed = true;
      relocatedLabels.push(label);
      labelIndex = rebuildLabelIndex();
    }
    processed.add(label);
  });

  if (changed) {
    removeFallthroughGotos(codeAttr.code.codeItems);
  }

  return { changed, labels: relocatedLabels };
}

function resolveHandlerLabel(entry, codeItems) {
  if (entry.handlerLbl) return entry.handlerLbl;
  if (typeof entry.handler_pc === 'number') {
    for (const item of codeItems) {
      if (item && item.pc === entry.handler_pc && item.labelDef) {
        return trimLabel(item.labelDef);
      }
    }
  }
  if (entry.handlerLbl == null && entry.handler_pc == null && entry.handlerLblName) {
    return entry.handlerLblName;
  }
  return null;
}

function relocateHandlerLabel(label, codeItems, labelIndex) {
  if (!labelIndex.has(label)) {
    return false;
  }

  const startIdx = labelIndex.get(label);
  const block = [];
  let idx = startIdx;
  while (idx < codeItems.length) {
    const item = codeItems[idx];
    if (!item) break;
    if (idx > startIdx && item.labelDef) break;
    block.push(item);
    idx += 1;
  }

  if (!isTrivialRethrowBlock(block)) {
    return false;
  }

  if (labelReferencedOutsideBlock(label, codeItems, startIdx, idx)) {
    return false;
  }

  const removed = codeItems.splice(startIdx, block.length);
  codeItems.push(...removed);
  return true;
}

function isTrivialRethrowBlock(blockItems) {
  if (!blockItems.length) return false;
  let athrowCount = 0;
  for (const item of blockItems) {
    if (!item || !item.instruction) continue;
    if (isAthrowInstruction(item.instruction)) {
      athrowCount += 1;
    } else {
      return false;
    }
  }
  return athrowCount === 1;
}

function isAthrowInstruction(instruction) {
  if (!instruction) return false;
  if (typeof instruction === 'string') {
    return instruction === 'athrow';
  }
  if (typeof instruction === 'object' && instruction.op) {
    return instruction.op === 'athrow';
  }
  return false;
}

function labelReferencedOutsideBlock(label, codeItems, blockStart, blockEnd) {
  for (let i = 0; i < codeItems.length; i += 1) {
    if (i >= blockStart && i < blockEnd) continue;
    const item = codeItems[i];
    if (!item || !item.instruction) continue;
    if (instructionReferencesLabel(item.instruction, label)) {
      return true;
    }
  }
  return false;
}

function instructionReferencesLabel(instruction, label) {
  if (!instruction || typeof instruction !== 'object') return false;
  if (typeof instruction.arg === 'string' && instruction.arg === label) {
    return true;
  }
  return containsLabel(instruction.arg, label);
}

function containsLabel(value, label) {
  if (!value) return false;
  if (typeof value === 'string') {
    return value === label;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsLabel(entry, label));
  }
  if (typeof value === 'object') {
    return Object.values(value).some((entry) => containsLabel(entry, label));
  }
  return false;
}

function removeFallthroughGotos(codeItems) {
  for (let i = 0; i < codeItems.length - 1; i += 1) {
    const item = codeItems[i];
    if (!item || !item.instruction) continue;
    const instruction = item.instruction;
    if (!instruction || typeof instruction !== 'object' || instruction.op !== 'goto') {
      continue;
    }
    const next = codeItems[i + 1];
    if (!next || !next.labelDef) continue;
    const nextLabel = trimLabel(next.labelDef);
    if (instruction.arg === nextLabel) {
      if (item.labelDef) {
        delete item.instruction;
        delete item.pc;
      } else {
        codeItems.splice(i, 1);
        i -= 1;
      }
    }
  }
}

function trimLabel(label) {
  if (!label) return label;
  return label.endsWith(':') ? label.slice(0, -1) : label;
}

module.exports = { relocateTrivialHandlers };

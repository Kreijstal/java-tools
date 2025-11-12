'use strict';

const TERMINATING_OPCODES = new Set([
  'return',
  'ireturn',
  'lreturn',
  'freturn',
  'dreturn',
  'areturn',
  'athrow',
  'goto',
  'goto_w',
  'tableswitch',
  'lookupswitch',
]);

function inlineSinglePredecessorBlocks(astRoot) {
  const merges = [];
  let changed = false;

  for (const classItem of astRoot.classes || []) {
    const className = classItem.className || 'UnknownClass';
    for (const member of classItem.items || []) {
      if (!member || member.type !== 'method' || !member.method) continue;
      const method = member.method;
      const result = inlineInMethod(method);
      if (result.changed) {
        changed = true;
        result.labels.forEach((label) =>
          merges.push({
            className,
            methodName: method.name,
            descriptor: method.descriptor,
            label,
          }),
        );
      }
    }
  }

  return { changed, merges };
}

function inlineInMethod(method) {
  const codeAttr = (method.attributes || []).find((attr) => attr.type === 'code');
  if (!codeAttr || !codeAttr.code || !Array.isArray(codeAttr.code.codeItems)) {
    return { changed: false, labels: [] };
  }
  const labelPredecessors = computeLabelPredecessors(codeAttr);
  const exceptionCoverage = buildExceptionCoverage(codeAttr);
  let labelIndex = buildLabelIndex(codeAttr.code.codeItems);
  let changed = false;
  const labels = [];
  const items = codeAttr.code.codeItems;

  for (let i = 0; i < items.length; i += 1) {
    const entry = items[i];
    if (!entry || !entry.instruction || typeof entry.instruction !== 'object') continue;
    if (entry.instruction.op !== 'goto') continue;
    const target = entry.instruction.arg;
    if (typeof target !== 'string') continue;
    if (!labelIndex.has(target)) continue;
    if (labelPredecessors.get(target) !== 1) continue;

    const targetIdx = labelIndex.get(target);
    if (targetIdx == null || targetIdx <= i) continue;
    const block = extractBlock(items, targetIdx);
    if (!block.length) continue;
    if (hasFallthroughPredecessor(items, targetIdx)) continue;
    const predecessorRanges = blockRanges(items, exceptionCoverage, i, 1);
    const targetRanges = blockRanges(items, exceptionCoverage, targetIdx, block.length);
    if (!rangesMatch(predecessorRanges, targetRanges)) continue;
    if (blockHasStackMapFrame(block)) continue;

    const removed = items.splice(targetIdx, block.length);
    items.splice(i, 1, ...removed);
    labels.push(target);
    changed = true;
    labelIndex = buildLabelIndex(items);
    i += removed.length - 1;
  }

  return { changed, labels };
}

function computeLabelPredecessors(codeAttr) {
  const refs = new Map();
  const items = codeAttr.code.codeItems || [];
  items.forEach((item) => {
    if (item && item.labelDef) {
      refs.set(trimLabel(item.labelDef), 0);
    }
  });

  const increment = (label) => {
    if (!label) return;
    refs.set(label, (refs.get(label) || 0) + 1);
  };

  items.forEach((item) => {
    if (!item || !item.instruction) return;
    collectLabels(item.instruction).forEach(increment);
  });

  (codeAttr.code.exceptionTable || []).forEach((entry) => {
    ['startLbl', 'endLbl', 'handlerLbl'].forEach((key) => {
      if (entry[key]) {
        increment(entry[key]);
      }
    });
  });

  items.forEach((item, idx) => {
    if (!item || !item.instruction) return;
    const op = typeof item.instruction === 'string' ? item.instruction : item.instruction.op;
    if (!op || TERMINATING_OPCODES.has(op)) return;
    const fallthroughLabel = findNextLabel(items, idx + 1);
    if (fallthroughLabel) {
      increment(fallthroughLabel);
    }
  });

  return refs;
}

function buildLabelIndex(codeItems) {
  const index = new Map();
  codeItems.forEach((item, idx) => {
    if (item && item.labelDef) {
      index.set(trimLabel(item.labelDef), idx);
    }
  });
  return index;
}

function extractBlock(codeItems, startIdx) {
  const block = [];
  for (let idx = startIdx; idx < codeItems.length; idx += 1) {
    const item = codeItems[idx];
    if (idx > startIdx && item && item.labelDef) {
      break;
    }
    block.push(item);
  }
  return block;
}

function blockHasStackMapFrame(block) {
  return block.some((item) => item && item.stackMapFrame);
}

function hasFallthroughPredecessor(codeItems, targetIdx) {
  for (let idx = targetIdx - 1; idx >= 0; idx -= 1) {
    const item = codeItems[idx];
    if (!item) continue;
    if (item.labelDef && !item.instruction) continue;
    const instruction = item.instruction;
    if (!instruction) continue;
    const op = typeof instruction === 'string' ? instruction : instruction.op;
    if (!op) continue;
    return !TERMINATING_OPCODES.has(op);
  }
  return false;
}

function collectLabels(value) {
  const labels = [];
  gatherLabels(value, labels);
  return labels;
}

function gatherLabels(value, acc) {
  if (!value) return;
  if (typeof value === 'string') {
    if (value.startsWith('L')) {
      acc.push(value.replace(/:?$/, ''));
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => gatherLabels(entry, acc));
    return;
  }
  if (typeof value === 'object') {
    Object.values(value).forEach((entry) => gatherLabels(entry, acc));
  }
}

function trimLabel(label) {
  return label && label.endsWith(':') ? label.slice(0, -1) : label;
}

function buildExceptionCoverage(codeAttr) {
  const coverage = [];
  (codeAttr.code.exceptionTable || []).forEach((entry) => {
    if (typeof entry.start_pc === 'number' && typeof entry.end_pc === 'number') {
      coverage.push({ start: entry.start_pc, endExclusive: entry.end_pc });
    }
  });
  return coverage;
}

function blockRanges(codeItems, coverage, startIdx, count) {
  const ranges = new Set();
  for (let idx = startIdx; idx < codeItems.length && (!count || idx < startIdx + count); idx += 1) {
    const item = codeItems[idx];
    if (!item || typeof item.pc !== 'number') continue;
    coverage.forEach((range, index) => {
      if (item.pc >= range.start && item.pc < range.endExclusive) {
        ranges.add(index);
      }
    });
  }
  return ranges;
}

function rangesMatch(rangesA, rangesB) {
  if (!rangesA || !rangesB) return false;
  if (rangesA.size !== rangesB.size) return false;
  for (const value of rangesA) {
    if (!rangesB.has(value)) {
      return false;
    }
  }
  return true;
}

function findNextLabel(codeItems, startIdx) {
  for (let idx = startIdx; idx < codeItems.length; idx += 1) {
    const item = codeItems[idx];
    if (!item) continue;
    if (item.labelDef) {
      return trimLabel(item.labelDef);
    }
    if (item.instruction) {
      break;
    }
  }
  return null;
}

module.exports = { inlineSinglePredecessorBlocks };

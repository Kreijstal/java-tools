'use strict';

function runSimplifyStringLengthNotCompare(astRoot) {
  let rewrites = 0;
  for (const cls of astRoot.classes || []) {
    for (const item of cls.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      for (const attr of item.method.attributes || []) {
        const code = attr && attr.type === 'code' && attr.code;
        if (!code || !Array.isArray(code.codeItems)) continue;
        rewrites += rewriteCode(code);
      }
    }
  }
  return { changed: rewrites > 0, rewrites };
}

function rewriteCode(code) {
  const items = code.codeItems;
  const used = collectUsedLabels(code);
  let rewrites = 0;
  for (let i = 0; i < items.length; i += 1) {
    if (op(items[i]) !== 'iconst_m1') continue;
    for (let lenIndex = i + 1; lenIndex <= Math.min(i + 8, items.length - 4); lenIndex += 1) {
      if (!isStringLength(items[lenIndex])) continue;
      if (op(items[lenIndex + 1]) !== 'iconst_m1' || op(items[lenIndex + 2]) !== 'ixor') continue;
      const branch = items[lenIndex + 3];
      const branchOp = op(branch);
      if (branchOp !== 'if_icmpeq' && branchOp !== 'if_icmpne') continue;
      if (!canMoveValueItems(items, i + 1, lenIndex, used)) continue;
      if (!canRemoveItems(items, i, i, used) || !canRemoveItems(items, lenIndex + 1, lenIndex + 2, used)) continue;
      const moved = items.slice(i + 1, lenIndex + 1).map((item, offset) =>
        cloneItem(item, offset === 0 ? items[i] : item));
      items.splice(
        i,
        lenIndex - i + 4,
        ...moved,
        { instruction: 'iconst_0' },
        itemWithInstruction(branch, { op: branchOp, arg: arg(branch) }),
      );
      rewrites += 1;
      i -= 1;
      break;
    }
  }
  return rewrites;
}

function isStringLength(item) {
  if (op(item) !== 'invokevirtual') return false;
  const ref = arg(item);
  return Array.isArray(ref) && ref[1] === 'java/lang/String' &&
    Array.isArray(ref[2]) && ref[2][0] === 'length' && ref[2][1] === '()I';
}

function canMoveValueItems(items, start, end, used) {
  for (let i = start; i <= end; i += 1) {
    if (!items[i] || !items[i].instruction) return false;
    if (items[i].labelDef && used.has(trimLabel(items[i].labelDef))) return false;
    if (items[i].stackMapFrame || items[i].lineNumber) return false;
  }
  return true;
}

function canRemoveItems(items, start, end, used) {
  for (let i = start; i <= end; i += 1) {
    if (!items[i]) return false;
    if (items[i].labelDef && used.has(trimLabel(items[i].labelDef))) return false;
    if (items[i].stackMapFrame || items[i].lineNumber) return false;
  }
  return true;
}

function collectUsedLabels(code) {
  const used = new Set();
  for (const entry of code.exceptionTable || []) {
    for (const label of [entry.startLbl, entry.endLbl, entry.handlerLbl, entry.startLabel, entry.endLabel, entry.handlerLabel]) {
      const normalized = trimLabel(label);
      if (normalized) used.add(normalized);
    }
  }
  for (const item of code.codeItems || []) {
    const insn = item && item.instruction;
    if (!insn || typeof insn !== 'object') continue;
    if (typeof insn.arg === 'string') {
      const label = trimLabel(insn.arg);
      if (label) used.add(label);
    }
  }
  return used;
}

function cloneItem(item, labelSource = item) {
  const out = {};
  if (labelSource && labelSource.labelDef) out.labelDef = labelSource.labelDef;
  out.instruction = cloneInstruction(item.instruction);
  return out;
}

function itemWithInstruction(labelSource, instruction) {
  const out = {};
  if (labelSource && labelSource.labelDef) out.labelDef = labelSource.labelDef;
  out.instruction = instruction;
  return out;
}

function cloneInstruction(insn) {
  if (!insn || typeof insn === 'string') return insn;
  return { ...insn, arg: cloneValue(insn.arg) };
}

function cloneValue(value) {
  return Array.isArray(value) ? value.map(cloneValue) : value;
}

function op(item) {
  const insn = item && item.instruction;
  return typeof insn === 'string' ? insn : insn && insn.op;
}

function arg(item) {
  const insn = item && typeof item.instruction === 'object' ? item.instruction : null;
  return insn && insn.arg;
}

function trimLabel(label) {
  return typeof label === 'string' ? label.replace(/:$/, '') : null;
}

module.exports = {
  runSimplifyStringLengthNotCompare,
  rewriteCode,
};

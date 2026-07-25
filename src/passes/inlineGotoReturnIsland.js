'use strict';

const RETURN_OPS = new Set(['ireturn', 'lreturn', 'freturn', 'dreturn', 'areturn', 'return']);

function runInlineGotoReturnIsland(astRoot, options = {}) {
  let fired = 0;
  for (const cls of astRoot.classes || []) {
    for (const item of cls.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      for (const attr of item.method.attributes || []) {
        const code = attr && attr.type === 'code' && attr.code;
        if (!code || !Array.isArray(code.codeItems)) continue;
        fired += inlineMethod(code, {
          owner: cls.className,
          name: item.method.name,
          desc: item.method.descriptor,
          verbose: !!options.verbose,
        });
      }
    }
  }
  return { changed: fired > 0, fired };
}

function inlineMethod(code, opts) {
  const items = code.codeItems;
  const table = Array.isArray(code.exceptionTable) ? code.exceptionTable : [];
  let fired = 0;

  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (op(item) !== 'goto') continue;
    const target = trimLabel(arg(item));
    if (!target) continue;
    const sourceLabel = trimLabel(item.labelDef);
    if (!sourceLabel) continue;
    if (table.some((row) => trimLabel(row.startLbl) === sourceLabel)) continue;

    const targetIdx = findLabelIndex(items, target);
    if (targetIdx < 0 || targetIdx <= i) continue;
    const body = readReturnIsland(items, targetIdx);
    if (!body) continue;
    const branchPreds = countBranchPreds(items, target);
    if (branchPreds !== 1) continue;

    const islandRows = table
      .map((row, idx) => ({ row, idx }))
      .filter(({ row }) => trimLabel(row.startLbl) === target);
    if (islandRows.length !== 1) continue;
    const islandEnd = trimLabel(islandRows[0].row.endLbl);
    if (islandEnd && !body.labels.has(islandEnd)) continue;
    if (!sameHandlerSetAtLabels(items, table, sourceLabel, target)) continue;

    const replacement = body.items.map((entry) => cloneWithoutLabel(entry));
    if (replacement.length === 0) continue;
    if (item.labelDef) replacement[0].labelDef = item.labelDef;
    items.splice(i, 1, ...replacement);

    const adjustedTargetIdx = findLabelIndex(items, target);
    if (adjustedTargetIdx >= 0) {
      items.splice(adjustedTargetIdx, body.items.length);
    }
    for (let j = islandRows.length - 1; j >= 0; j -= 1) {
      table.splice(islandRows[j].idx, 1);
    }
    fired += 1;
    if (opts.verbose) {
      console.log(`[inline-goto-return-island] ${opts.owner}.${opts.name}${opts.desc}: goto ${target}`);
    }
  }

  return fired;
}

function readReturnIsland(items, labelIdx) {
  const out = [];
  const labels = new Set();
  let real = 0;
  for (let i = labelIdx; i < items.length && out.length < 4; i += 1) {
    const item = items[i];
    if (!item) continue;
    if (item.labelDef) labels.add(trimLabel(item.labelDef));
    out.push(item);
    const itemOp = op(item);
    if (!itemOp) continue;
    real += 1;
    if (RETURN_OPS.has(itemOp)) {
      return real >= 2 ? { items: out, labels } : null;
    }
    if (isBranch(itemOp) || itemOp === 'athrow') return null;
  }
  return null;
}

function countBranchPreds(items, label) {
  let count = 0;
  for (const item of items) {
    if (!item || !item.instruction) continue;
    const itemOp = op(item);
    if (!isBranch(itemOp)) continue;
    const targets = branchTargets(item.instruction);
    if (targets.some((target) => trimLabel(target) === label)) count += 1;
  }
  return count;
}

function sameHandlerSetAtLabels(items, table, leftLabel, rightLabel) {
  if (!leftLabel || !rightLabel) return false;
  const left = handlerSetAtLabel(items, table, leftLabel);
  const right = handlerSetAtLabel(items, table, rightLabel);
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function handlerSetAtLabel(items, table, label) {
  const idx = findLabelIndex(items, label);
  if (idx < 0) return [];
  const out = [];
  for (const row of table) {
    const start = findLabelIndex(items, trimLabel(row.startLbl));
    const end = findLabelIndex(items, trimLabel(row.endLbl));
    if (start < 0 || end < 0) continue;
    if (start <= idx && idx < end) {
      out.push(`${trimLabel(row.handlerLbl)}\u0000${row.catch_type || row.catchType || ''}`);
    }
  }
  return out.sort();
}

function branchTargets(insn) {
  if (!insn || typeof insn !== 'object') return [];
  if (insn.op === 'tableswitch' || insn.op === 'lookupswitch') {
    const out = [];
    const value = insn.arg;
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (Array.isArray(entry)) out.push(entry[entry.length - 1]);
        else if (typeof entry === 'string') out.push(entry);
      }
    }
    return out;
  }
  return typeof insn.arg === 'string' ? [insn.arg] : [];
}

function isBranch(itemOp) {
  return itemOp === 'goto' || itemOp === 'goto_w' || /^if/.test(itemOp || '') ||
    itemOp === 'tableswitch' || itemOp === 'lookupswitch';
}

function findLabelIndex(items, label) {
  for (let i = 0; i < items.length; i += 1) {
    if (trimLabel(items[i] && items[i].labelDef) === label) return i;
  }
  return -1;
}

function cloneWithoutLabel(item) {
  const clone = { ...item };
  delete clone.labelDef;
  delete clone.pc;
  if (item.instruction && typeof item.instruction === 'object') {
    clone.instruction = JSON.parse(JSON.stringify(item.instruction));
  }
  return clone;
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
  return typeof label === 'string' ? label.replace(/:$/, '') : null;
}

module.exports = { runInlineGotoReturnIsland, inlineMethod };

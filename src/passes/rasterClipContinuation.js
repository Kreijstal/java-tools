'use strict';

// Generic transform for raster clip-pair CFGs.
//
// Some obfuscated rasterizers share continuation blocks between two bounds
// checks. CFR can fail to structure that shape. This pass rewrites inferred
// x/y clip-pair skeletons into an explicit flag-shaped CFG using a fresh int
// local. Inferred targets must contain all four raster quadrants.

const INVERSE = {
  iflt: 'ifge',
  ifge: 'iflt',
  ifgt: 'ifle',
  ifle: 'ifgt',
  ifeq: 'ifne',
  ifne: 'ifeq',
  if_icmplt: 'if_icmpge',
  if_icmpge: 'if_icmplt',
  if_icmpgt: 'if_icmple',
  if_icmple: 'if_icmpgt',
  if_icmpeq: 'if_icmpne',
  if_icmpne: 'if_icmpeq',
};

function runRasterClipContinuation(astRoot, options = {}) {
  let fired = 0;
  const targets = new Set((options.targets || []).map((target) => `${target.className}.${target.methodName}:${target.descriptor}`));
  const inferTargets = options.inferTargets !== false;
  for (const cls of astRoot.classes || []) {
    if (!cls) continue;
    for (const item of cls.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      const explicit = targets.has(`${cls.className}.${item.method.name}:${item.method.descriptor}`);
      if (!explicit && !inferTargets) continue;
      const codeAttr = (item.method.attributes || []).find((attr) => attr.type === 'code');
      if (!codeAttr || !codeAttr.code) continue;
      fired += transformMethod(codeAttr.code.codeItems || [], codeAttr.code, {
        ...options,
        requireFullRaster: !explicit,
      });
    }
  }
  return { changed: fired > 0, fired };
}

function transformMethod(codeItems, code, options) {
  const quadrants = options.quadrants && options.quadrants.length > 0
    ? options.quadrants
    : inferQuadrants(codeItems);
  if (quadrants.length === 0) return 0;
  if (options.requireFullRaster && quadrants.length !== 4) return 0;
  if (!quadrants.every((q) => hasLabel(codeItems, q.xStart) && hasLabel(codeItems, q.scan))) {
    return 0;
  }
  const flagLocal = String(code.localsSize || 0);
  code.localsSize = Number(flagLocal) + 1;

  const state = { nextLabel: 71000, flagLocal };
  let fired = 0;
  for (const q of quadrants) {
    initFlagBefore(codeItems, q.xStart, state);
    deleteInstructionAtLabel(codeItems, q.xDup, 'dup');
    replaceClipCond(codeItems, q.xCond, q.xOp, q.yStart, q.xAdjust, q.rowDone, false, q.xZeroGoto, q.xLocal, state);
    deleteInstructionAtLabel(codeItems, q.yDup, 'dup');
    replaceClipCond(codeItems, q.yCond, q.yOp, q.scan, q.yAdjust, q.rowDone, true, q.yZeroGoto, q.yLocal, state);
    fired += 1;
  }
  return fired;
}

function inferQuadrants(codeItems) {
  const clips = [];
  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (getOp(item && item.instruction) !== 'dup') continue;
    const store = nextReal(codeItems, i);
    const cond = store && nextReal(codeItems, store.idx);
    const storeInsn = store && store.item.instruction;
    const condInsn = cond && cond.item.instruction;
    if (!storeInsn || getOp(storeInsn) !== 'istore') continue;
    if (!condInsn || !INVERSE[condInsn.op]) continue;
    const target = trim(condInsn.arg);
    const start = expressionStartLabel(codeItems, i);
    if (!start) continue;
    clips.push({
      start,
      dup: trim(item.labelDef),
      cond: trim(cond.item.labelDef),
      op: condInsn.op,
      target,
      local: String(storeInsn.arg),
      condIdx: cond.idx,
      targetIdx: findLabelIndex(codeItems, target),
    });
  }

  const quadrants = [];
  for (let i = 0; i < clips.length - 1; i += 1) {
    const x = clips[i];
    const y = clips[i + 1];
    if (x.targetIdx < 0 || y.targetIdx < 0) continue;
    if (x.condIdx >= y.condIdx || x.targetIdx >= y.condIdx) continue;
    const xGoto = firstGotoBetween(codeItems, x.condIdx + 1, x.targetIdx);
    const yGoto = firstGotoBetween(codeItems, y.condIdx + 1, y.targetIdx);
    if (!xGoto || !yGoto) continue;
    if (trim(xGoto.instruction.arg) !== trim(yGoto.instruction.arg)) continue;
    quadrants.push({
      xStart: x.start,
      xDup: x.dup,
      xCond: x.cond,
      xOp: x.op,
      xLocal: x.local,
      yStart: x.target,
      xAdjust: nextLabelAfter(codeItems, x.condIdx),
      xZeroGoto: trim(xGoto.labelDef),
      yDup: y.dup,
      yCond: y.cond,
      yOp: y.op,
      yLocal: y.local,
      scan: y.target,
      yAdjust: nextLabelAfter(codeItems, y.condIdx),
      yZeroGoto: trim(yGoto.labelDef),
      rowDone: trim(yGoto.instruction.arg),
    });
    i += 1;
  }
  return quadrants;
}

function expressionStartLabel(codeItems, dupIdx) {
  for (let i = dupIdx - 1; i >= 0; i -= 1) {
    const item = codeItems[i];
    if (!item || !item.instruction) continue;
    if (isStackBoundary(item.instruction)) {
      const next = nextReal(codeItems, i);
      return next ? trim(next.item.labelDef) : null;
    }
  }
  const first = nextReal(codeItems, -1);
  return first ? trim(first.item.labelDef) : null;
}

function isStackBoundary(insn) {
  const itemOp = getOp(insn);
  return typeof itemOp === 'string' && (
    itemOp.endsWith('store') ||
    /^([aifdl]?store_[0-3])$/.test(itemOp) ||
    itemOp === 'goto' ||
    itemOp === 'athrow' ||
    itemOp === 'return' ||
    itemOp.endsWith('return') ||
    itemOp.startsWith('if')
  );
}

function firstGotoBetween(codeItems, startIdx, endIdx) {
  for (let i = endIdx - 1; i >= startIdx; i -= 1) {
    const item = codeItems[i];
    const insn = item && item.instruction;
    if (getOp(insn) === 'goto' && trim(item.labelDef)) return item;
  }
  return null;
}

function nextLabelAfter(codeItems, idx) {
  const next = nextReal(codeItems, idx);
  return next ? trim(next.item.labelDef) : null;
}

function nextReal(codeItems, idx) {
  for (let i = idx + 1; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (item && item.instruction) return { idx: i, item };
  }
  return null;
}

function replaceClipCond(codeItems, label, expectedOp, oldTarget, outsideLabel, rowDone, isY, zeroGoto, compareLocal, state) {
  const idx = findLabelIndex(codeItems, label);
  if (idx < 0) throw new Error(`raster-clip-continuation: missing ${label}`);
  const item = codeItems[idx];
  const insn = item && item.instruction;
  if (!insn || typeof insn !== 'object' || insn.op !== expectedOp || trim(insn.arg) !== oldTarget) {
    throw new Error(`raster-clip-continuation: unexpected condition at ${label}`);
  }

  const after = fresh(state);
  retargetGoto(codeItems, zeroGoto, rowDone, after);

  codeItems.splice(idx, 1,
    itemWith(label, { op: 'iload', arg: compareLocal }),
    itemWith(fresh(state), { op: INVERSE[expectedOp], arg: outsideLabel }),
    itemWith(fresh(state), 'iconst_1'),
    itemWith(fresh(state), { op: 'istore', arg: state.flagLocal }),
    itemWith(fresh(state), { op: 'goto', arg: after }),
  );

  insertBefore(codeItems, oldTarget, [
    itemWith(fresh(state), 'iconst_1'),
    itemWith(fresh(state), { op: 'istore', arg: state.flagLocal }),
    itemWith(after, { op: 'iload', arg: state.flagLocal }),
    itemWith(fresh(state), { op: 'ifeq', arg: rowDone }),
    ...(isY ? [] : [
      itemWith(fresh(state), 'iconst_0'),
      itemWith(fresh(state), { op: 'istore', arg: state.flagLocal }),
    ]),
  ]);
}

function initFlagBefore(codeItems, label, state) {
  insertBefore(codeItems, label, [
    itemWith(fresh(state), 'iconst_0'),
    itemWith(fresh(state), { op: 'istore', arg: state.flagLocal }),
  ]);
}

function retargetGoto(codeItems, label, fromTarget, toTarget) {
  const idx = findLabelIndex(codeItems, label);
  if (idx < 0) throw new Error(`raster-clip-continuation: missing goto ${label}`);
  const insn = codeItems[idx] && codeItems[idx].instruction;
  if (!insn || typeof insn !== 'object' || insn.op !== 'goto' || trim(insn.arg) !== fromTarget) {
    throw new Error(`raster-clip-continuation: unexpected goto at ${label}`);
  }
  codeItems[idx].instruction = { ...insn, arg: toTarget };
}

function deleteInstructionAtLabel(codeItems, label, expectedOp) {
  const idx = findLabelIndex(codeItems, label);
  if (idx < 0) throw new Error(`raster-clip-continuation: missing ${label}`);
  if (getOp(codeItems[idx].instruction) !== expectedOp) {
    throw new Error(`raster-clip-continuation: unexpected op at ${label}`);
  }
  codeItems.splice(idx, 1);
}

function insertBefore(codeItems, label, items) {
  const idx = findLabelIndex(codeItems, label);
  if (idx < 0) throw new Error(`raster-clip-continuation: missing insertion target ${label}`);
  codeItems.splice(idx, 0, ...items);
}

function itemWith(label, instruction) {
  return { labelDef: `${label}:`, instruction };
}

function fresh(state) {
  return `L${state.nextLabel++}`;
}

function hasLabel(codeItems, label) {
  return findLabelIndex(codeItems, label) >= 0;
}

function findLabelIndex(codeItems, label) {
  const wanted = `${label}:`;
  return codeItems.findIndex((item) => item && item.labelDef === wanted);
}

function trim(label) {
  return typeof label === 'string' ? label.replace(/:$/, '') : label;
}

function getOp(insn) {
  return typeof insn === 'string' ? insn : insn && insn.op;
}

module.exports = {
  runRasterClipContinuation,
  runCkClipFlag: runRasterClipContinuation,
  inferQuadrants,
};

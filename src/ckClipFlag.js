'use strict';

// Targeted transform for Dekobloko ck.a(IIIIII)V.
//
// The four rotated raster quadrants contain the same clip-pair CFG:
//   x-bound shortcut -> shared y-clip continuation
//   y-bound shortcut -> shared scanline continuation
//
// CFR rejects those shared continuations. The reduction in dekobloko-work
// shows that javac's flag-shaped CFG is accepted, so this pass rewrites the
// exact clip-pair skeletons into that shape using local 40 as a synthetic int
// boolean. No decompiler output is inspected.

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

const QUADRANTS = [
  {
    xStart: 'L710', xDup: 'L720', xCond: 'L723', xOp: 'iflt',
    yStart: 'L785', xAdjust: 'L726', xZeroGoto: 'L738',
    yDup: 'L795', yCond: 'L798', yOp: 'iflt',
    scan: 'L860', yAdjust: 'L801', yZeroGoto: 'L813', rowDone: 'L945',
  },
  {
    xStart: 'L1012', xDup: 'L1022', xCond: 'L1025', xOp: 'iflt',
    yStart: 'L1087', xAdjust: 'L1028', xZeroGoto: 'L1040',
    yDup: 'L1093', yCond: 'L1096', yOp: 'ifge',
    scan: 'L1160', yAdjust: 'L1099', yZeroGoto: 'L1111', rowDone: 'L1245',
  },
  {
    xStart: 'L1317', xDup: 'L1323', xCond: 'L1326', xOp: 'ifge',
    yStart: 'L1390', xAdjust: 'L1329', xZeroGoto: 'L1341',
    yDup: 'L1400', yCond: 'L1403', yOp: 'iflt',
    scan: 'L1465', yAdjust: 'L1406', yZeroGoto: 'L1418', rowDone: 'L1550',
  },
  {
    xStart: 'L1617', xDup: 'L1623', xCond: 'L1626', xOp: 'ifge',
    yStart: 'L1690', xAdjust: 'L1629', xZeroGoto: 'L1641',
    yDup: 'L1696', yCond: 'L1699', yOp: 'ifge',
    scan: 'L1763', yAdjust: 'L1702', yZeroGoto: 'L1714', rowDone: 'L1848',
  },
];

function runCkClipFlag(astRoot, options = {}) {
  let fired = 0;
  for (const cls of astRoot.classes || []) {
    if (!cls || cls.className !== 'ck') continue;
    for (const item of cls.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      if (item.method.name !== 'a' || item.method.descriptor !== '(IIIIII)V') continue;
      const codeAttr = (item.method.attributes || []).find((attr) => attr.type === 'code');
      if (!codeAttr || !codeAttr.code) continue;
      fired += transformMethod(codeAttr.code.codeItems || [], codeAttr.code, options);
    }
  }
  return { changed: fired > 0, fired };
}

function transformMethod(codeItems, code, options) {
  if (!QUADRANTS.every((q) => hasLabel(codeItems, q.xStart) && hasLabel(codeItems, q.scan))) {
    return 0;
  }
  if ((code.localsSize || 0) < 41) code.localsSize = 41;

  const state = { nextLabel: 71000, verbose: !!options.verbose };
  let fired = 0;
  for (const q of QUADRANTS) {
    initFlagBefore(codeItems, q.xStart, state);
    deleteInstructionAtLabel(codeItems, q.xDup, 'dup');
    replaceClipCond(codeItems, q.xCond, q.xOp, q.yStart, q.xAdjust, q.rowDone, false, q.xZeroGoto, state);
    deleteInstructionAtLabel(codeItems, q.yDup, 'dup');
    replaceClipCond(codeItems, q.yCond, q.yOp, q.scan, q.yAdjust, q.rowDone, true, q.yZeroGoto, state);
    fired += 1;
  }
  return fired;
}

function replaceClipCond(codeItems, label, expectedOp, oldTarget, outsideLabel, rowDone, isY, zeroGoto, state) {
  const idx = findLabelIndex(codeItems, label);
  if (idx < 0) throw new Error(`ck-clip-flag: missing ${label}`);
  const item = codeItems[idx];
  const insn = item && item.instruction;
  if (!insn || typeof insn !== 'object' || insn.op !== expectedOp || trim(insn.arg) !== oldTarget) {
    throw new Error(`ck-clip-flag: unexpected condition at ${label}`);
  }

  const after = fresh(state);
  retargetGoto(codeItems, zeroGoto, rowDone, after);

  codeItems.splice(idx, 1,
    itemWith(label, { op: 'iload', arg: '35' }),
    itemWith(fresh(state), { op: INVERSE[expectedOp], arg: outsideLabel }),
    itemWith(fresh(state), 'iconst_1'),
    itemWith(fresh(state), { op: 'istore', arg: '40' }),
    itemWith(fresh(state), { op: 'goto', arg: after }),
  );

  insertBefore(codeItems, oldTarget, [
    itemWith(fresh(state), 'iconst_1'),
    itemWith(fresh(state), { op: 'istore', arg: '40' }),
    itemWith(after, { op: 'iload', arg: '40' }),
    itemWith(fresh(state), { op: 'ifeq', arg: rowDone }),
    ...(isY ? [] : [
      itemWith(fresh(state), 'iconst_0'),
      itemWith(fresh(state), { op: 'istore', arg: '40' }),
    ]),
  ]);
}

function initFlagBefore(codeItems, label, state) {
  insertBefore(codeItems, label, [
    itemWith(fresh(state), 'iconst_0'),
    itemWith(fresh(state), { op: 'istore', arg: '40' }),
  ]);
}

function retargetGoto(codeItems, label, fromTarget, toTarget) {
  const idx = findLabelIndex(codeItems, label);
  if (idx < 0) throw new Error(`ck-clip-flag: missing goto ${label}`);
  const insn = codeItems[idx] && codeItems[idx].instruction;
  if (!insn || typeof insn !== 'object' || insn.op !== 'goto' || trim(insn.arg) !== fromTarget) {
    throw new Error(`ck-clip-flag: unexpected goto at ${label}`);
  }
  codeItems[idx].instruction = { ...insn, arg: toTarget };
}

function deleteInstructionAtLabel(codeItems, label, expectedOp) {
  const idx = findLabelIndex(codeItems, label);
  if (idx < 0) throw new Error(`ck-clip-flag: missing ${label}`);
  if (getOp(codeItems[idx].instruction) !== expectedOp) {
    throw new Error(`ck-clip-flag: unexpected op at ${label}`);
  }
  codeItems.splice(idx, 1);
}

function insertBefore(codeItems, label, items) {
  const idx = findLabelIndex(codeItems, label);
  if (idx < 0) throw new Error(`ck-clip-flag: missing insertion target ${label}`);
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

module.exports = { runCkClipFlag };

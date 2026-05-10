'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  collapseGotoChains,
  inlineGotoConstReturns,
  mergeAdjacentConstReturns,
  shareConstReturnGotos,
  removeUnreferencedAfterTerminals,
} = require('../src/passes/controlFlowDce');

test('removes unreferenced instructions after terminal opcodes', () => {
  const code = {
    codeItems: [
      { labelDef: 'L0:', instruction: 'iconst_1' },
      { labelDef: 'L1:', instruction: 'ireturn' },
      { labelDef: 'L2:', instruction: 'astore_2' },
      { labelDef: 'L3:', instruction: 'aload_2' },
      { labelDef: 'L4:', instruction: 'athrow' },
      { labelDef: 'L5:', instruction: 'iconst_0' },
      { labelDef: 'L6:', instruction: 'ireturn' },
    ],
    exceptionTable: [],
  };

  assert.equal(removeUnreferencedAfterTerminals(code), 5);
  assert.deepEqual(code.codeItems.map((item) => item.labelDef), ['L0:', 'L1:']);
});

test('keeps terminal tail when a label is still referenced', () => {
  const code = {
    codeItems: [
      { labelDef: 'L0:', instruction: { op: 'goto', arg: 'L3' } },
      { labelDef: 'L1:', instruction: 'return' },
      { labelDef: 'L2:', instruction: 'aconst_null' },
      { labelDef: 'L3:', instruction: 'athrow' },
    ],
    exceptionTable: [],
  };

  assert.equal(removeUnreferencedAfterTerminals(code), 1);
  assert.deepEqual(code.codeItems.map((item) => item.labelDef), ['L0:', 'L1:', 'L3:']);
});

test('collapses goto to goto chains', () => {
  const code = {
    codeItems: [
      { labelDef: 'L0:', instruction: { op: 'goto', arg: 'L1' } },
      { labelDef: 'L1:', instruction: { op: 'goto', arg: 'L2' } },
      { labelDef: 'L2:', instruction: 'return' },
    ],
    exceptionTable: [],
  };

  assert.equal(collapseGotoChains(code), 1);
  assert.deepEqual(code.codeItems[0].instruction, { op: 'goto', arg: 'L2' });
});

test('collapses goto chains to a fixed point', () => {
  const code = {
    codeItems: [
      { labelDef: 'L0:', instruction: { op: 'goto', arg: 'L1' } },
      { labelDef: 'L1:', instruction: { op: 'goto', arg: 'L2' } },
      { labelDef: 'L2:', instruction: { op: 'goto', arg: 'L3' } },
      { labelDef: 'L3:', instruction: 'return' },
    ],
    exceptionTable: [],
  };

  assert.equal(collapseGotoChains(code), 3);
  assert.deepEqual(code.codeItems[0].instruction, { op: 'goto', arg: 'L3' });
});

test('inlines gotos to constant return blocks', () => {
  const code = {
    codeItems: [
      { labelDef: 'L0:', instruction: { op: 'goto', arg: 'L2' } },
      { labelDef: 'L1:', instruction: 'iconst_1' },
      { labelDef: 'L2:', instruction: 'iconst_0' },
      { labelDef: 'L3:', instruction: 'ireturn' },
    ],
    exceptionTable: [],
  };

  assert.equal(inlineGotoConstReturns(code), 1);
  assert.equal(code.codeItems[0].instruction, 'iconst_0');
  assert.equal(code.codeItems[1].instruction, 'ireturn');
});

test('retargets duplicate adjacent constant return blocks', () => {
  const code = {
    codeItems: [
      { labelDef: 'L0:', instruction: { op: 'ifnull', arg: 'L2' } },
      { labelDef: 'L1:', instruction: 'iconst_1' },
      { instruction: 'ireturn' },
      { labelDef: 'L2:', instruction: 'iconst_1' },
      { instruction: 'ireturn' },
    ],
    exceptionTable: [],
  };

  assert.equal(mergeAdjacentConstReturns(code), 1);
  assert.deepEqual(code.codeItems[0].instruction, { op: 'ifnull', arg: 'L1' });
});

test('shares ireturn for goto to nearby constant return block', () => {
  const code = {
    codeItems: [
      { labelDef: 'L0:', instruction: { op: 'ifnull', arg: 'Ltrue' } },
      { labelDef: 'L1:', instruction: { op: 'goto', arg: 'Lfalse' } },
      { labelDef: 'Ltrue:', instruction: 'iconst_1' },
      { instruction: 'ireturn' },
      { labelDef: 'Lfalse:', instruction: 'iconst_0' },
      { instruction: 'ireturn' },
    ],
    exceptionTable: [],
  };

  assert.equal(shareConstReturnGotos(code), 1);
  assert.equal(code.codeItems[1].instruction, 'iconst_0');
  assert.deepEqual(code.codeItems[2].instruction, { op: 'goto', arg: 'Lshared_return' });
  assert.equal(code.codeItems[4].labelDef, 'Lshared_return:');
});

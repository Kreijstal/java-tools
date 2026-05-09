'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rewriteCode } = require('../src/materializeStackJoinStores');

test('materializes reference stack values on goto edges into a labelled join store', () => {
  const code = {
    codeItems: [
      { labelDef: 'L0:', instruction: { op: 'getstatic', arg: ['Field', 'gn', ['gn_c', '[[Ljava/lang/String;']] } },
      { labelDef: 'L1:', instruction: { op: 'ifnonnull', arg: 'L4' } },
      { labelDef: 'L2:', instruction: 'aconst_null' },
      { labelDef: 'L3:', instruction: { op: 'goto', arg: 'L9' } },
      { labelDef: 'L4:', instruction: { op: 'getstatic', arg: ['Field', 'gn', ['gn_c', '[[Ljava/lang/String;']] } },
      { labelDef: 'L5:', instruction: { op: 'aload', arg: '1' } },
      { labelDef: 'L6:', instruction: 'aaload' },
      { labelDef: 'L7:', instruction: { op: 'ifnonnull', arg: 'L11' } },
      { labelDef: 'L8:', instruction: 'aconst_null' },
      { labelDef: 'L8b:', instruction: { op: 'goto', arg: 'L9' } },
      { labelDef: 'L11:', instruction: { op: 'getstatic', arg: ['Field', 'gn', ['gn_c', '[[Ljava/lang/String;']] } },
      { labelDef: 'L12:', instruction: { op: 'aload', arg: '1' } },
      { labelDef: 'L13:', instruction: 'aaload' },
      { labelDef: 'L14:', instruction: { op: 'aload', arg: '2' } },
      { labelDef: 'L15:', instruction: 'aaload' },
      { labelDef: 'L9:', instruction: { op: 'astore', arg: '5' } },
      { labelDef: 'L10:', instruction: { op: 'aload', arg: '5' } },
      { labelDef: 'L16:', instruction: 'areturn' },
    ],
    exceptionTable: [],
  };

  assert.equal(rewriteCode(code), 2);
  assert.deepEqual(code.codeItems.slice(2, 6).map((item) => item.instruction), [
    'aconst_null',
    { op: 'astore', arg: '5' },
    { op: 'goto', arg: 'L10' },
    { op: 'getstatic', arg: ['Field', 'gn', ['gn_c', '[[Ljava/lang/String;']] },
  ]);
  assert.deepEqual(
    code.codeItems
      .filter((item) => item.instruction && item.instruction.op === 'goto')
      .map((item) => item.instruction.arg),
    ['L10', 'L10'],
  );
});

test('skips joins with non-goto incoming branches', () => {
  const code = {
    codeItems: [
      { labelDef: 'L0:', instruction: { op: 'ifnonnull', arg: 'L9' } },
      { labelDef: 'L1:', instruction: 'aconst_null' },
      { labelDef: 'L2:', instruction: { op: 'goto', arg: 'L9' } },
      { labelDef: 'L9:', instruction: { op: 'astore', arg: '5' } },
      { labelDef: 'L10:', instruction: { op: 'aload', arg: '5' } },
    ],
    exceptionTable: [],
  };

  assert.equal(rewriteCode(code), 0);
});

test('skips single-goto ternaries because CFR already handles them reliably', () => {
  const code = {
    codeItems: [
      { labelDef: 'L0:', instruction: { op: 'aload', arg: '1' } },
      { labelDef: 'L1:', instruction: { op: 'goto', arg: 'L9' } },
      { labelDef: 'L2:', instruction: 'aconst_null' },
      { labelDef: 'L9:', instruction: { op: 'astore', arg: '4' } },
      { labelDef: 'L10:', instruction: { op: 'aload', arg: '4' } },
    ],
    exceptionTable: [],
  };

  assert.equal(rewriteCode(code), 0);
});

test('allows reference locals reused as primitives after the materialized range', () => {
  const code = {
    codeItems: [
      { labelDef: 'L0:', instruction: 'aconst_null' },
      { labelDef: 'L1:', instruction: { op: 'goto', arg: 'L9' } },
      { labelDef: 'L2:', instruction: { op: 'aload', arg: '1' } },
      { labelDef: 'L3:', instruction: { op: 'goto', arg: 'L9' } },
      { labelDef: 'L9:', instruction: { op: 'astore', arg: '4' } },
      { labelDef: 'L10:', instruction: { op: 'aload', arg: '4' } },
      { labelDef: 'L11:', instruction: { op: 'istore', arg: '4' } },
    ],
    exceptionTable: [],
  };

  assert.equal(rewriteCode(code), 2);
});

test('creates a successor label when the instruction after the join is unlabeled', () => {
  const code = {
    codeItems: [
      { labelDef: 'L0:', instruction: 'aconst_null' },
      { labelDef: 'L1:', instruction: { op: 'goto', arg: 'L9' } },
      { labelDef: 'L2:', instruction: { op: 'aload', arg: '1' } },
      { labelDef: 'L3:', instruction: { op: 'goto', arg: 'L9' } },
      { labelDef: 'L9:', instruction: { op: 'astore', arg: '4' } },
      { instruction: { op: 'aload', arg: '4' } },
    ],
    exceptionTable: [],
  };

  assert.equal(rewriteCode(code), 2);
  assert.equal(code.codeItems[7].labelDef, 'Lstack_join_after:');
  assert.deepEqual(
    code.codeItems
      .filter((item) => item.instruction && item.instruction.op === 'goto')
      .map((item) => item.instruction.arg),
    ['Lstack_join_after', 'Lstack_join_after'],
  );
});

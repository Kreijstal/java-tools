'use strict';

const test = require('tape');
const { rewriteCode } = require('../src/inlineSingleUseBooleanBranch');

test('removes single-use boolean store feeding branch', (t) => {
  const code = {
    codeItems: [
      { instruction: 'iconst_0' },
      { instruction: { op: 'invokestatic', arg: ['Method', 'mb', ['a', '(ZI)Z']] } },
      { instruction: { op: 'istore', arg: '6' } },
      { instruction: { op: 'iload', arg: '6' } },
      { instruction: { op: 'ifne', arg: 'L1' } },
      { labelDef: 'L0:', instruction: 'iconst_m1' },
      { instruction: 'ireturn' },
      { labelDef: 'L1:', instruction: 'return' },
    ],
  };

  t.equal(rewriteCode(code), 1);
  t.deepEqual(code.codeItems.map((item) => item.instruction), [
    'iconst_0',
    { op: 'invokestatic', arg: ['Method', 'mb', ['a', '(ZI)Z']] },
    { op: 'ifne', arg: 'L1' },
    'iconst_m1',
    'ireturn',
    'return',
  ]);
  t.end();
});

test('keeps boolean store when local is read later', (t) => {
  const code = {
    codeItems: [
      { instruction: { op: 'invokestatic', arg: ['Method', 'mb', ['a', '(ZI)Z']] } },
      { instruction: 'istore_1' },
      { instruction: 'iload_1' },
      { instruction: { op: 'ifne', arg: 'L1' } },
      { instruction: 'iload_1' },
      { labelDef: 'L1:', instruction: 'ireturn' },
    ],
  };

  t.equal(rewriteCode(code), 0);
  t.equal(code.codeItems.length, 6);
  t.end();
});

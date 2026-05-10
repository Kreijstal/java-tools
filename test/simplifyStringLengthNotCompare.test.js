'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rewriteCode } = require('../src/passes/simplifyStringLengthNotCompare');

test('simplifies -1 == ~string.length() into length == 0', () => {
  const code = {
    codeItems: [
      { labelDef: 'L0:', instruction: 'iconst_m1' },
      { labelDef: 'L1:', instruction: 'aload_0' },
      { labelDef: 'L2:', instruction: { op: 'getfield', arg: ['Field', 'rk', ['E', 'Ljava/lang/String;']] } },
      { labelDef: 'L3:', instruction: { op: 'invokevirtual', arg: ['Method', 'java/lang/String', ['length', '()I']] } },
      { labelDef: 'L4:', instruction: 'iconst_m1' },
      { labelDef: 'L5:', instruction: 'ixor' },
      { labelDef: 'L6:', instruction: { op: 'if_icmpeq', arg: 'Ltrue' } },
    ],
    exceptionTable: [],
  };

  assert.equal(rewriteCode(code), 1);
  assert.deepEqual(code.codeItems.map((item) => item.instruction), [
    'aload_0',
    { op: 'getfield', arg: ['Field', 'rk', ['E', 'Ljava/lang/String;']] },
    { op: 'invokevirtual', arg: ['Method', 'java/lang/String', ['length', '()I']] },
    'iconst_0',
    { op: 'if_icmpeq', arg: 'Ltrue' },
  ]);
});

test('leaves non-string length-like invokes alone', () => {
  const code = {
    codeItems: [
      { instruction: 'iconst_m1' },
      { instruction: 'aload_0' },
      { instruction: { op: 'invokevirtual', arg: ['Method', 'xs', ['length', '()I']] } },
      { instruction: 'iconst_m1' },
      { instruction: 'ixor' },
      { instruction: { op: 'if_icmpeq', arg: 'Ltrue' } },
    ],
    exceptionTable: [],
  };

  assert.equal(rewriteCode(code), 0);
});

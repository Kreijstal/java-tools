'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rewriteCode } = require('../src/passes/liftSourceScopeLocals');

test('lifts array element locals used across a dense forward dispatch', () => {
  const code = {
    localsSize: '8',
    codeItems: [
      { labelDef: 'L0:', instruction: { op: 'aload', arg: '4' } },
      { labelDef: 'L1:', instruction: 'iconst_0' },
      { labelDef: 'L2:', instruction: 'aaload' },
      { labelDef: 'L3:', instruction: { op: 'astore', arg: '5' } },
      { labelDef: 'L4:', instruction: { op: 'iload', arg: '1' } },
      { labelDef: 'L5:', instruction: { op: 'ifeq', arg: 'L20' } },
      { labelDef: 'L6:', instruction: { op: 'iload', arg: '1' } },
      { labelDef: 'L7:', instruction: { op: 'ifne', arg: 'L30' } },
      { labelDef: 'L8:', instruction: { op: 'iload', arg: '1' } },
      { labelDef: 'L9:', instruction: { op: 'iflt', arg: 'L40' } },
      { labelDef: 'L10:', instruction: { op: 'iload', arg: '1' } },
      { labelDef: 'L11:', instruction: { op: 'ifgt', arg: 'L50' } },
      { labelDef: 'L12:', instruction: { op: 'goto', arg: 'L60' } },
      { labelDef: 'L20:', instruction: { op: 'aload', arg: '5' } },
      { labelDef: 'L21:', instruction: { op: 'iload', arg: '2' } },
      { labelDef: 'L22:', instruction: 'iaload' },
      { labelDef: 'L23:', instruction: 'pop' },
      { labelDef: 'L30:', instruction: { op: 'aload', arg: '5' } },
      { labelDef: 'L31:', instruction: { op: 'iload', arg: '2' } },
      { labelDef: 'L32:', instruction: 'iaload' },
      { labelDef: 'L33:', instruction: 'pop' },
      { labelDef: 'L40:', instruction: { op: 'aload', arg: '5' } },
      { labelDef: 'L41:', instruction: { op: 'iload', arg: '2' } },
      { labelDef: 'L42:', instruction: 'iaload' },
      { labelDef: 'L43:', instruction: 'pop' },
      { labelDef: 'L50:', instruction: { op: 'aload', arg: '5' } },
      { labelDef: 'L51:', instruction: { op: 'iload', arg: '2' } },
      { labelDef: 'L52:', instruction: 'iaload' },
      { labelDef: 'L53:', instruction: 'pop' },
      { labelDef: 'L60:', instruction: 'return' },
    ],
  };

  assert.equal(rewriteCode(code, { name: 'm', descriptor: '(II)V' }), 4);
  assert.deepEqual(code.codeItems.slice(13, 17).map((item) => item.instruction), [
    { op: 'aload', arg: '4' },
    'iconst_0',
    'aaload',
    { op: 'astore', arg: '5' },
  ]);
  assert.equal(code.codeItems[13].labelDef, 'L20:');
});

test('skips parameter locals and sparse branches', () => {
  const code = {
    localsSize: '4',
    codeItems: [
      { instruction: { op: 'aload', arg: '3' } },
      { instruction: 'iconst_0' },
      { instruction: 'aaload' },
      { instruction: { op: 'astore', arg: '2' } },
      { instruction: { op: 'goto', arg: 'L20' } },
      { labelDef: 'L20:', instruction: { op: 'aload', arg: '2' } },
      { instruction: { op: 'iload', arg: '1' } },
      { instruction: 'iaload' },
    ],
  };

  assert.equal(rewriteCode(code, { name: 'm', descriptor: '(Ljava/lang/Object;I)V' }), 0);
});

test('skips exception table methods because CFR can expose protected-range gotos', () => {
  const code = {
    localsSize: '8',
    exceptionTable: [{ startLbl: 'L0', endLbl: 'L60', handlerLbl: 'H' }],
    codeItems: [
      { labelDef: 'L0:', instruction: { op: 'aload', arg: '4' } },
      { instruction: 'iconst_0' },
      { instruction: 'aaload' },
      { instruction: { op: 'astore', arg: '5' } },
      { instruction: { op: 'ifeq', arg: 'L20' } },
      { instruction: { op: 'ifne', arg: 'L30' } },
      { instruction: { op: 'iflt', arg: 'L40' } },
      { instruction: { op: 'ifgt', arg: 'L50' } },
      { labelDef: 'L20:', instruction: { op: 'aload', arg: '5' } },
      { instruction: { op: 'iload', arg: '2' } },
      { instruction: 'iaload' },
      { labelDef: 'H:', instruction: 'athrow' },
    ],
  };

  assert.equal(rewriteCode(code, { name: 'm', descriptor: '(II)V' }), 0);
});

test('skips methods with explicit throw islands', () => {
  const code = {
    localsSize: '8',
    codeItems: [
      { instruction: { op: 'aload', arg: '4' } },
      { instruction: 'iconst_0' },
      { instruction: 'aaload' },
      { instruction: { op: 'astore', arg: '5' } },
      { instruction: { op: 'ifeq', arg: 'L20' } },
      { instruction: { op: 'ifne', arg: 'L30' } },
      { instruction: { op: 'iflt', arg: 'L40' } },
      { instruction: { op: 'ifgt', arg: 'L50' } },
      { instruction: 'athrow' },
      { labelDef: 'L20:', instruction: { op: 'aload', arg: '5' } },
      { instruction: { op: 'iload', arg: '2' } },
      { instruction: 'iaload' },
    ],
  };

  assert.equal(rewriteCode(code, { name: 'm', descriptor: '(II)V', accessFlags: 16 }), 0);
});

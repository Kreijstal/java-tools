'use strict';

const test = require('tape');
const { rewriteCode } = require('../src/removeDeadDupStore');

test('removes dead second store from dup store pair', (t) => {
  const code = {
    codeItems: [
      { instruction: { op: 'newarray', arg: 'int' } },
      { instruction: 'dup' },
      { instruction: { op: 'astore', arg: '9' } },
      { instruction: { op: 'astore', arg: '5' } },
      { instruction: { op: 'aload', arg: '9' } },
      { instruction: 'arraylength' },
      { instruction: 'pop' },
      { instruction: 'return' },
    ],
  };

  t.equal(rewriteCode(code), 1);
  t.deepEqual(code.codeItems.map((item) => item.instruction), [
    { op: 'newarray', arg: 'int' },
    { op: 'astore', arg: '9' },
    { op: 'aload', arg: '9' },
    'arraylength',
    'pop',
    'return',
  ]);
  t.end();
});

test('keeps dup store pair when second local is loaded', (t) => {
  const code = {
    codeItems: [
      { instruction: { op: 'newarray', arg: 'int' } },
      { instruction: 'dup' },
      { instruction: { op: 'astore', arg: '9' } },
      { instruction: { op: 'astore', arg: '5' } },
      { instruction: { op: 'aload', arg: '5' } },
      { instruction: 'arraylength' },
      { instruction: 'pop' },
      { instruction: 'return' },
    ],
  };

  t.equal(rewriteCode(code), 0);
  t.equal(code.codeItems.length, 8);
  t.end();
});

test('moves unreferenced label from removed dup', (t) => {
  const code = {
    codeItems: [
      { instruction: { op: 'newarray', arg: 'int' } },
      { labelDef: 'L1:', instruction: 'dup' },
      { instruction: { op: 'astore', arg: '9' } },
      { instruction: { op: 'astore', arg: '5' } },
      { instruction: { op: 'aload', arg: '9' } },
      { instruction: 'arraylength' },
      { instruction: 'pop' },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(rewriteCode(code), 1);
  t.equal(code.codeItems[1].labelDef, 'L1:');
  t.deepEqual(code.codeItems[1].instruction, { op: 'astore', arg: '9' });
  t.end();
});

test('keeps referenced labelled dup', (t) => {
  const code = {
    codeItems: [
      { instruction: { op: 'goto', arg: 'L1' } },
      { instruction: { op: 'newarray', arg: 'int' } },
      { labelDef: 'L1:', instruction: 'dup' },
      { instruction: { op: 'astore', arg: '9' } },
      { instruction: { op: 'astore', arg: '5' } },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(rewriteCode(code), 0);
  t.equal(code.codeItems.length, 6);
  t.end();
});

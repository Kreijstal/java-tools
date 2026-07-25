'use strict';

const test = require('tape');
const { rewriteCode } = require('../src/passes/normalizeBooleanSinks');

test('normalizes int local assigned to boolean field', (t) => {
  const field = ['Field', 'Demo', ['flag', 'Z']];
  const code = {
    codeItems: [
      { instruction: 'aload_0' },
      { instruction: { op: 'iload', arg: '7' } },
      { instruction: { op: 'putfield', arg: field } },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(rewriteCode(code), 1);
  t.deepEqual(code.codeItems.map((item) => item.instruction), [
    'aload_0',
    { op: 'iload', arg: '7' },
    { op: 'ifeq', arg: 'L_bool_sink_false' },
    'iconst_1',
    { op: 'goto', arg: 'L_bool_sink_store' },
    'iconst_0',
    'nop',
    { op: 'putfield', arg: field },
    'return',
  ]);
  t.equal(code.codeItems[5].labelDef, 'L_bool_sink_false:');
  t.equal(code.codeItems[6].labelDef, 'L_bool_sink_store:');
  t.end();
});

test('removes byte narrowing before boolean array store', (t) => {
  const code = {
    codeItems: [
      { instruction: { op: 'getstatic', arg: ['Field', 'Flags', ['values', '[Z']] } },
      { instruction: { op: 'iload', arg: '2' } },
      { instruction: { op: 'iload', arg: '5' } },
      { instruction: 'i2b' },
      { instruction: 'bastore' },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(rewriteCode(code), 1);
  t.deepEqual(code.codeItems.map((item) => item.instruction), [
    { op: 'getstatic', arg: ['Field', 'Flags', ['values', '[Z']] },
    { op: 'iload', arg: '2' },
    { op: 'iload', arg: '5' },
    'bastore',
    'return',
  ]);
  t.end();
});

test('keeps constants assigned to boolean fields unchanged', (t) => {
  const field = ['Field', 'Demo', ['flag', 'Z']];
  const code = {
    codeItems: [
      { instruction: 'aload_0' },
      { instruction: 'iconst_1' },
      { instruction: { op: 'putfield', arg: field } },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(rewriteCode(code), 0);
  t.deepEqual(code.codeItems.map((item) => item.instruction), [
    'aload_0',
    'iconst_1',
    { op: 'putfield', arg: field },
    'return',
  ]);
  t.end();
});

test('does not use earlier boolean-array reads as the bastore sink type', (t) => {
  const code = {
    codeItems: [
      { instruction: 'aload_0' },
      { instruction: { op: 'getfield', arg: ['Field', 'Demo', ['mask', '[Z']] } },
      { instruction: { op: 'iload', arg: '1' } },
      { instruction: 'baload' },
      { instruction: { op: 'ifeq', arg: 'L0' } },
      { instruction: 'aload_0' },
      { instruction: { op: 'getfield', arg: ['Field', 'Demo', ['bytes', '[B']] } },
      { instruction: { op: 'iload', arg: '2' } },
      { instruction: { op: 'iload', arg: '1' } },
      { instruction: 'i2b' },
      { instruction: 'bastore' },
      { labelDef: 'L0:', instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(rewriteCode(code), 0);
  t.equal(code.codeItems[9].instruction, 'i2b');
  t.end();
});

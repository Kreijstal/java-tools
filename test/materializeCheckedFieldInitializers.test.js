'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rewriteCode } = require('../src/materializeCheckedFieldInitializers');

test('materializes constructor field object allocation through a temporary local', () => {
  const field = ['Field', 'il', ['il_a', 'Ljava/awt/Robot;']];
  const code = {
    codeItems: [
      { instruction: 'aload_0' },
      { instruction: { op: 'invokespecial', arg: ['Method', 'java/lang/Object', ['<init>', '()V']] } },
      { instruction: 'aload_0' },
      { instruction: { op: 'new', arg: 'java/awt/Robot' } },
      { instruction: 'dup' },
      { instruction: { op: 'invokespecial', arg: ['Method', 'java/awt/Robot', ['<init>', '()V']] } },
      { instruction: { op: 'putfield', arg: field } },
      { instruction: 'return' },
    ],
  };

  assert.equal(rewriteCode(code), 1);
  assert.deepEqual(code.codeItems.slice(2, 9).map((item) => item.instruction), [
    { op: 'new', arg: 'java/awt/Robot' },
    'dup',
    { op: 'invokespecial', arg: ['Method', 'java/awt/Robot', ['<init>', '()V']] },
    'astore_1',
    'aload_0',
    'aload_1',
    { op: 'putfield', arg: field },
  ]);
});

test('skips primitive field initializers', () => {
  const code = {
    codeItems: [
      { instruction: 'aload_0' },
      { instruction: { op: 'new', arg: 'java/lang/Object' } },
      { instruction: 'dup' },
      { instruction: { op: 'invokespecial', arg: ['Method', 'java/lang/Object', ['<init>', '()V']] } },
      { instruction: { op: 'putfield', arg: ['Field', 'x', ['n', 'I']] } },
    ],
  };

  assert.equal(rewriteCode(code), 0);
});

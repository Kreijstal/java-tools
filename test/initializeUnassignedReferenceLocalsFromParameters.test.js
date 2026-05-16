const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeCode } = require('../src/passes/initializeUnassignedReferenceLocalsFromParameters');

test('initializes first-read reference accumulator locals from matching parameter', () => {
  const method = { descriptor: '(II[I)[I', flags: [] };
  const code = {
    localsSize: 6,
    codeItems: [
      { instruction: 'aload_0' },
      { instruction: 'iload_1' },
      { instruction: 'iload_2' },
      { instruction: { op: 'aload', arg: '5' } },
      { instruction: { op: 'invokevirtual', arg: ['Method', 'x', ['a', '(II[I)[I']] } },
      { instruction: { op: 'astore', arg: '5' } },
      { instruction: { op: 'aload', arg: '5' } },
      { instruction: 'areturn' },
    ],
  };

  assert.equal(initializeCode(code, method, { minNullInitLocal: 5 }), 1);
  assert.deepEqual(code.codeItems.slice(0, 2).map((item) => item.instruction), [
    'aload_3',
    { op: 'astore', arg: '5' },
  ]);
});

test('does not initialize when matching parameter descriptor is ambiguous', () => {
  const method = { descriptor: '([I[I)V', flags: [] };
  const code = {
    codeItems: [
      { instruction: { op: 'aload', arg: '4' } },
      { instruction: { op: 'invokevirtual', arg: ['Method', 'x', ['a', '([I)V']] } },
      { instruction: { op: 'astore', arg: '4' } },
    ],
  };

  assert.equal(initializeCode(code, method), 0);
  assert.equal(code.codeItems.length, 3);
});

test('initializes conditionally assigned reference locals to null', () => {
  const method = { descriptor: '()V', flags: [] };
  const code = {
    localsSize: 6,
    codeItems: [
      { instruction: { op: 'invokestatic', arg: ['Method', 'd', ['a', '()Lopa;']] } },
      { instruction: { op: 'checkcast', arg: 'opa' } },
      { instruction: { op: 'astore', arg: '5' } },
      { instruction: { op: 'aload', arg: '5' } },
      { instruction: { op: 'ifnull', arg: 'Done' } },
      { labelDef: 'Done:', instruction: 'return' },
    ],
  };

  assert.equal(initializeCode(code, method, { minNullInitLocal: 5 }), 1);
  assert.deepEqual(code.codeItems.slice(0, 2).map((item) => item.instruction), [
    'aconst_null',
    { op: 'astore', arg: '5' },
  ]);
});

test('places constructor reference initializers after super call', () => {
  const method = { name: '<init>', descriptor: '()V', flags: [] };
  const code = {
    codeItems: [
      { instruction: 'aload_0' },
      { instruction: { op: 'invokespecial', arg: ['Method', 'java/lang/Object', ['<init>', '()V']] } },
      { instruction: { op: 'checkcast', arg: 'opa' } },
      { instruction: { op: 'astore', arg: '5' } },
      { instruction: { op: 'aload', arg: '5' } },
      { instruction: { op: 'ifnull', arg: 'Done' } },
      { labelDef: 'Done:', instruction: 'return' },
    ],
  };

  assert.equal(initializeCode(code, method, { minNullInitLocal: 5 }), 1);
  assert.deepEqual(code.codeItems.slice(2, 4).map((item) => item.instruction), [
    'aconst_null',
    { op: 'astore', arg: '5' },
  ]);
});

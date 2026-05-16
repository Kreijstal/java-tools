const test = require('node:test');
const assert = require('node:assert/strict');
const { castCode } = require('../src/passes/castReferenceArrayAssignmentsToDeclaredTypes');

test('casts copied reference array into declared local array type', () => {
  const method = { descriptor: '(I[Lml;)V', flags: [] };
  const code = {
    codeItems: [
      { instruction: { op: 'anewarray', arg: 'ml' } },
      { instruction: { op: 'astore', arg: '4' } },
      { instruction: { op: 'aload', arg: '4' } },
      { instruction: 'astore_2' },
      { instruction: 'return' },
    ],
  };

  assert.equal(castCode(code, method), 1);
  assert.deepEqual(code.codeItems[3].instruction, { op: 'checkcast', arg: '[Lml;' });
  assert.equal(code.codeItems[4].instruction, 'astore_2');
});

test('casts copied reference array before declared field store', () => {
  const method = { descriptor: '()[Ljava/lang/Object;', flags: [] };
  const code = {
    codeItems: [
      { instruction: { op: 'anewarray', arg: 'ml' } },
      { instruction: { op: 'astore', arg: '4' } },
      { instruction: 'aload_0' },
      { instruction: { op: 'aload', arg: '4' } },
      { instruction: { op: 'putfield', arg: ['Field', 'Owner', ['items', '[Lml;']] } },
      { instruction: 'return' },
    ],
  };

  assert.equal(castCode(code, method), 1);
  assert.deepEqual(code.codeItems[4].instruction, { op: 'checkcast', arg: '[Lml;' });
});

test('collapses immediate casted array alias into declared target local', () => {
  const method = { descriptor: '(I[Lml;)V', flags: [] };
  const code = {
    codeItems: [
      { instruction: { op: 'invokestatic', arg: ['Method', 'Owner', ['next', '()[Lml;']] } },
      { instruction: { op: 'astore', arg: '4' } },
      { instruction: { op: 'aload', arg: '4' } },
      { instruction: { op: 'checkcast', arg: '[Lml;' } },
      { instruction: 'astore_2' },
      { instruction: 'return' },
    ],
  };

  assert.equal(castCode(code, method), 1);
  assert.equal(code.codeItems[1].instruction, 'astore_2');
  assert.equal(code.codeItems[2].instruction, 'aload_2');
});

test('collapses immediate array aliases and redirects later source loads', () => {
  const method = { descriptor: '()[Ljava/lang/Object;', flags: [] };
  const code = {
    codeItems: [
      { instruction: { op: 'invokeinterface', arg: ['InterfaceMethod', 'dja', ['a', '(II)[Ltv;']] } },
      { instruction: { op: 'checkcast', arg: '[Ltv;' } },
      { instruction: { op: 'astore', arg: '12' } },
      { instruction: { op: 'aload', arg: '12' } },
      { instruction: { op: 'astore', arg: '6' } },
      { instruction: { op: 'aload', arg: '12' } },
      { instruction: 'areturn' },
    ],
  };

  assert.equal(castCode(code, method), 2);
  assert.deepEqual(code.codeItems[2].instruction, { op: 'astore', arg: '6' });
  assert.deepEqual(code.codeItems[3].instruction, { op: 'aload', arg: '6' });
  assert.deepEqual(code.codeItems[5].instruction, { op: 'aload', arg: '6' });
});

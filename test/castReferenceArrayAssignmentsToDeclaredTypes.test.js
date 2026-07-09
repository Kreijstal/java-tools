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

test('refuses immediate array alias collapse when the source local is read after the window', () => {
  // Slot 12 is aliased to slot 6, but slot 12 is also loaded later on another
  // path (index 6). The linear forward rename stops at the next store, so a
  // naive collapse would delete slot 12's only definition while that later
  // load survives — an uninitialized read (real-JVM VerifyError, CFR
  // "Exception decompiling"). The gate must decline and leave the code intact.
  const method = { descriptor: '()[Ljava/lang/Object;', flags: [] };
  const code = {
    codeItems: [
      { instruction: { op: 'invokeinterface', arg: ['InterfaceMethod', 'dja', ['a', '(II)[Ltv;']] } },
      { instruction: { op: 'astore', arg: '12' } },
      { instruction: { op: 'aload', arg: '12' } },
      { instruction: { op: 'astore', arg: '6' } },
      { instruction: { op: 'astore', arg: '12' } }, // redefine slot 12 (rename stop)
      { instruction: { op: 'aload', arg: '12' } },  // still reads slot 12
      { instruction: 'areturn' },
    ],
  };
  const before = JSON.parse(JSON.stringify(code.codeItems));
  assert.equal(castCode(code, method), 0);
  assert.deepEqual(code.codeItems, before);
});

test('refuses casted array alias collapse when the source local is read outside the window', () => {
  // Slot 12 is aliased to slot 2, but slot 12 is also read again later on
  // another path (index 6). Collapsing renames slot 12's store/load to slot 2
  // but not that later read, orphaning it (real-JVM VerifyError, CFR
  // "Exception decompiling"). The gate must decline the rename; a benign
  // same-type checkcast annotation elsewhere is allowed.
  const method = { descriptor: '(I)[Ljava/lang/Object;', flags: [] };
  const code = {
    codeItems: [
      { instruction: { op: 'invokestatic', arg: ['Method', 'Owner', ['next', '()[Ltv;']] } },
      { instruction: { op: 'astore', arg: '12' } },
      { instruction: { op: 'aload', arg: '12' } },
      { instruction: { op: 'checkcast', arg: '[Ltv;' } },
      { instruction: { op: 'astore', arg: '2' } },
      { instruction: { op: 'aload', arg: '12' } },   // later read of slot 12, off-window
      { instruction: 'areturn' },
    ],
  };
  castCode(code, method);
  // The alias store/load must NOT have been renamed away from slot 12.
  assert.equal(code.codeItems[1].instruction.op, 'astore');
  assert.equal(code.codeItems[1].instruction.arg, '12');
  assert.equal(code.codeItems[2].instruction.op, 'aload');
  assert.equal(code.codeItems[2].instruction.arg, '12');
  // The off-window read of slot 12 is preserved.
  const lastLoad = code.codeItems[code.codeItems.length - 2].instruction;
  assert.equal(lastLoad.op, 'aload');
  assert.equal(lastLoad.arg, '12');
});

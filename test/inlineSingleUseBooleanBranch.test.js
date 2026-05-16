'use strict';

const test = require('tape');
const { rewriteCode } = require('../src/passes/inlineSingleUseBooleanBranch');

test('removes single-use boolean store feeding branch', (t) => {
  const code = {
    codeItems: [
      { instruction: 'iconst_0' },
      { labelDef: 'Loop:', instruction: { op: 'invokevirtual', arg: ['Method', 'qc', ['b', '(II)Z']] } },
      { instruction: { op: 'istore', arg: '6' } },
      { instruction: { op: 'iload', arg: '6' } },
      { instruction: { op: 'ifne', arg: 'Loop' } },
      { labelDef: 'L0:', instruction: 'iconst_m1' },
      { instruction: 'ireturn' },
      { labelDef: 'L1:', instruction: 'return' },
    ],
  };

  t.equal(rewriteCode(code), 1);
  t.deepEqual(code.codeItems.map((item) => item.instruction), [
    'iconst_0',
    { op: 'invokevirtual', arg: ['Method', 'qc', ['b', '(II)Z']] },
    { op: 'ifne', arg: 'Loop' },
    'iconst_m1',
    'ireturn',
    'return',
  ]);
  t.end();
});

test('removes forward boolean branch when the stored value is not read', (t) => {
  const code = {
    codeItems: [
      { instruction: { op: 'getstatic', arg: ['Field', 'qc', ['qc_s', 'Lqk;']] } },
      { instruction: { op: 'ifnonnull', arg: 'Continue' } },
      { instruction: { op: 'invokestatic', arg: ['Method', 'mb', ['a', '(ZI)Z']] } },
      { instruction: { op: 'istore', arg: '10' } },
      { instruction: { op: 'iload', arg: '10' } },
      { instruction: { op: 'ifne', arg: 'Continue' } },
      { instruction: 'iconst_m1' },
      { instruction: 'ireturn' },
      { labelDef: 'Continue:', instruction: 'iconst_0' },
      { instruction: { op: 'istore', arg: '10' } },
      { instruction: 'return' },
    ],
  };

  t.equal(rewriteCode(code), 1);
  t.deepEqual(code.codeItems.map((item) => item.instruction), [
    { op: 'getstatic', arg: ['Field', 'qc', ['qc_s', 'Lqk;']] },
    { op: 'ifnonnull', arg: 'Continue' },
    { op: 'invokestatic', arg: ['Method', 'mb', ['a', '(ZI)Z']] },
    { op: 'ifne', arg: 'Continue' },
    'iconst_m1',
    'ireturn',
    'iconst_0',
    { op: 'istore', arg: '10' },
    'return',
  ]);
  t.end();
});

test('removes loop-carried boolean temp used only by branch tests', (t) => {
  const code = {
    codeItems: [
      { instruction: { op: 'getstatic', arg: ['Field', 'kf', ['I', 'Lqc;']] } },
      { instruction: 'iconst_2' },
      { instruction: 'iconst_1' },
      { instruction: { op: 'invokevirtual', arg: ['Method', 'qc', ['b', '(IZ)Z']] } },
      { instruction: { op: 'istore', arg: '5' } },
      { labelDef: 'Loop:', instruction: { op: 'iload', arg: '5' } },
      { instruction: { op: 'ifne', arg: 'Exit' } },
      { labelDef: 'Middle:', instruction: { op: 'invokestatic', arg: ['Method', 'ab', ['c', '(B)Z']] } },
      { instruction: { op: 'ifeq', arg: 'Exit' } },
      { instruction: { op: 'getstatic', arg: ['Field', 'kf', ['I', 'Lqc;']] } },
      { instruction: 'iconst_0' },
      { instruction: { op: 'invokevirtual', arg: ['Method', 'qc', ['e', '(Z)Z']] } },
      { instruction: { op: 'istore', arg: '5' } },
      { instruction: { op: 'goto', arg: 'Loop' } },
      { labelDef: 'Exit:', instruction: 'return' },
    ],
  };

  t.equal(rewriteCode(code), 1);
  t.deepEqual(code.codeItems.map((item) => item.instruction), [
    { op: 'getstatic', arg: ['Field', 'kf', ['I', 'Lqc;']] },
    'iconst_2',
    'iconst_1',
    { op: 'invokevirtual', arg: ['Method', 'qc', ['b', '(IZ)Z']] },
    { op: 'ifne', arg: 'Exit' },
    { op: 'invokestatic', arg: ['Method', 'ab', ['c', '(B)Z']] },
    { op: 'ifeq', arg: 'Exit' },
    { op: 'getstatic', arg: ['Field', 'kf', ['I', 'Lqc;']] },
    'iconst_0',
    { op: 'invokevirtual', arg: ['Method', 'qc', ['e', '(Z)Z']] },
    { op: 'ifne', arg: 'Exit' },
    { op: 'goto', arg: 'Middle' },
    'return',
  ]);
  t.end();
});

test('keeps loop-carried boolean temp when another path targets the temp load', (t) => {
  const code = {
    codeItems: [
      { instruction: { op: 'invokestatic', arg: ['Method', 'x', ['test', '()Z']] } },
      { instruction: 'istore_1' },
      { labelDef: 'Loop:', instruction: 'iload_1' },
      { instruction: { op: 'ifne', arg: 'Exit' } },
      { instruction: { op: 'ifeq', arg: 'Loop' } },
      { instruction: { op: 'invokestatic', arg: ['Method', 'x', ['test', '()Z']] } },
      { instruction: 'istore_1' },
      { instruction: { op: 'goto', arg: 'Loop' } },
      { labelDef: 'Exit:', instruction: 'return' },
    ],
  };

  t.equal(rewriteCode(code), 0);
  t.equal(code.codeItems.length, 9);
  t.end();
});

test('intizes boolean field stores into mixed int locals', (t) => {
  const code = {
    codeItems: [
      { instruction: 'iconst_0' },
      { instruction: { op: 'istore', arg: '5' } },
      { instruction: { op: 'getstatic', arg: ['Field', 'nk', ['nk_i', 'Z']] } },
      { instruction: { op: 'istore', arg: '5' } },
      { instruction: { op: 'iload', arg: '5' } },
      { instruction: { op: 'ifeq', arg: 'Done' } },
      { labelDef: 'Done:', instruction: 'return' },
    ],
  };

  t.equal(rewriteCode(code), 1);
  t.deepEqual(code.codeItems.map((item) => item.instruction), [
    'iconst_0',
    { op: 'istore', arg: '5' },
    { op: 'getstatic', arg: ['Field', 'nk', ['nk_i', 'Z']] },
    { op: 'ifeq', arg: 'L_bool_false' },
    'iconst_1',
    { op: 'goto', arg: 'L_bool_store' },
    'iconst_0',
    { op: 'istore', arg: '5' },
    { op: 'iload', arg: '5' },
    { op: 'ifeq', arg: 'Done' },
    'return',
  ]);
  t.equal(code.codeItems[6].labelDef, 'L_bool_false:');
  t.equal(code.codeItems[7].labelDef, 'L_bool_store:');
  t.end();
});

test('intizes boolean call stores into mixed int locals', (t) => {
  const code = {
    codeItems: [
      { instruction: 'iconst_0' },
      { instruction: { op: 'istore', arg: '5' } },
      { instruction: { op: 'invokevirtual', arg: ['Method', 'ml', ['k', '(B)Z']] } },
      { instruction: { op: 'istore', arg: '5' } },
      { instruction: { op: 'iload', arg: '5' } },
      { instruction: { op: 'ifne', arg: 'Done' } },
      { instruction: { op: 'iload', arg: '5' } },
      { instruction: { op: 'ifne', arg: 'Done' } },
      { labelDef: 'Done:', instruction: 'return' },
    ],
  };

  t.equal(rewriteCode(code), 1);
  t.deepEqual(code.codeItems.map((item) => item.instruction), [
    'iconst_0',
    { op: 'istore', arg: '5' },
    { op: 'invokevirtual', arg: ['Method', 'ml', ['k', '(B)Z']] },
    { op: 'ifeq', arg: 'L_bool_false' },
    'iconst_1',
    { op: 'goto', arg: 'L_bool_store' },
    'iconst_0',
    { op: 'istore', arg: '5' },
    { op: 'iload', arg: '5' },
    { op: 'ifne', arg: 'Done' },
    { op: 'iload', arg: '5' },
    { op: 'ifne', arg: 'Done' },
    'return',
  ]);
  t.end();
});

test('keeps boolean field stores for pure boolean locals', (t) => {
  const code = {
    codeItems: [
      { instruction: { op: 'getstatic', arg: ['Field', 'nk', ['nk_i', 'Z']] } },
      { instruction: 'istore_1' },
      { instruction: 'iload_1' },
      { instruction: { op: 'ireturn' } },
    ],
  };

  t.equal(rewriteCode(code), 0);
  t.equal(code.codeItems.length, 4);
  t.end();
});

test('keeps boolean store when local is read later', (t) => {
  const code = {
    codeItems: [
      { instruction: { op: 'invokeinterface', arg: ['InterfaceMethod', 'x', ['test', '()Z']] } },
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

test('keeps referenced labels on removed instructions', (t) => {
  const code = {
    codeItems: [
      { instruction: { op: 'invokestatic', arg: ['Method', 'x', ['test', '()Z']] } },
      { labelDef: 'Target:', instruction: 'istore_1' },
      { instruction: 'iload_1' },
      { instruction: { op: 'ifeq', arg: 'Done' } },
      { instruction: { op: 'goto', arg: 'Target' } },
      { labelDef: 'Done:', instruction: 'return' },
    ],
  };

  t.equal(rewriteCode(code), 0);
  t.equal(code.codeItems.length, 6);
  t.end();
});

test('keeps non-boolean invoke results', (t) => {
  const code = {
    codeItems: [
      { instruction: { op: 'invokestatic', arg: ['Method', 'x', ['count', '()I']] } },
      { instruction: 'istore_1' },
      { instruction: 'iload_1' },
      { instruction: { op: 'ifne', arg: 'L1' } },
      { labelDef: 'L1:', instruction: 'return' },
    ],
  };

  t.equal(rewriteCode(code), 0);
  t.equal(code.codeItems.length, 5);
  t.end();
});

test('keeps forward branch assignments because the stored value may be returned', (t) => {
  const code = {
    codeItems: [
      { instruction: { op: 'invokestatic', arg: ['Method', 'x', ['test', '()Z']] } },
      { instruction: 'istore_1' },
      { instruction: 'iload_1' },
      { instruction: { op: 'ifne', arg: 'Return' } },
      { instruction: { op: 'invokestatic', arg: ['Method', 'x', ['fallback', '()Z']] } },
      { instruction: 'istore_1' },
      { labelDef: 'Return:', instruction: 'iload_1' },
      { instruction: 'ireturn' },
    ],
  };

  t.equal(rewriteCode(code), 0);
  t.equal(code.codeItems.length, 8);
  t.end();
});

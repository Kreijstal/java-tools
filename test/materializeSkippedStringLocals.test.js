'use strict';

const test = require('tape');
const { materializeCode } = require('../src/passes/materializeSkippedStringLocals');

test('materializes skipped string local from base string before conditional refinement', (t) => {
  const code = {
    localsSize: '4',
    codeItems: [
      { instruction: { op: 'invokestatic', arg: ['Method', 'Debug', ['base', '()Ljava/lang/String;']] } },
      { instruction: { op: 'astore', arg: '1' } },
      { instruction: 'iload_0' },
      { instruction: { op: 'ifeq', arg: 'LDONE' } },
      { instruction: { op: 'aload', arg: '1' } },
      { instruction: { op: 'invokestatic', arg: ['Method', 'Debug', ['refine', '(Ljava/lang/String;)Ljava/lang/String;']] } },
      { instruction: { op: 'astore', arg: '2' } },
      { labelDef: 'LDONE:', instruction: { op: 'aload', arg: '2' } },
      { instruction: { op: 'invokestatic', arg: ['Method', 'Debug', ['draw', '(Ljava/lang/String;)V']] } },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(materializeCode(code), 1);
  t.deepEqual(code.codeItems[2].instruction, 'aload_1');
  t.equal(code.codeItems[3].instruction, 'astore_2');
  t.end();
});

test('materializes skipped string alias copied inside conditional refinement', (t) => {
  const code = {
    localsSize: '5',
    codeItems: [
      { instruction: { op: 'invokestatic', arg: ['Method', 'Debug', ['base', '()Ljava/lang/String;']] } },
      { instruction: { op: 'astore', arg: '1' } },
      { instruction: 'iload_0' },
      { instruction: { op: 'ifeq', arg: 'LDONE' } },
      { instruction: { op: 'aload', arg: '1' } },
      { instruction: { op: 'invokestatic', arg: ['Method', 'Debug', ['refine', '(Ljava/lang/String;)Ljava/lang/String;']] } },
      { instruction: { op: 'astore', arg: '2' } },
      { instruction: { op: 'aload', arg: '2' } },
      { instruction: { op: 'astore', arg: '3' } },
      { labelDef: 'LDONE:', instruction: { op: 'aload', arg: '3' } },
      { instruction: { op: 'invokestatic', arg: ['Method', 'Debug', ['draw', '(Ljava/lang/String;)V']] } },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(materializeCode(code), 1);
  t.deepEqual(code.codeItems.slice(2, 6).map((item) => item.instruction), [
    'aload_1',
    'astore_2',
    'aload_2',
    'astore_3',
  ]);
  t.end();
});

test('materializes skipped concrete receiver from target branch typed array load', (t) => {
  const code = {
    localsSize: '6',
    codeItems: [
      { instruction: { op: 'getstatic', arg: ['Field', 'Sprites', ['icons', '[Laja;']] } },
      { instruction: 'iconst_0' },
      { instruction: 'aaload' },
      { instruction: { op: 'astore', arg: '1' } },
      { instruction: 'iload_0' },
      { instruction: { op: 'ifne', arg: 'LREFRESH' } },
      { instruction: { op: 'goto', arg: 'LDONE' } },
      { labelDef: 'LREFRESH:', instruction: { op: 'getstatic', arg: ['Field', 'Sprites', ['icons', '[Laja;']] } },
      { instruction: 'iconst_1' },
      { instruction: 'aaload' },
      { instruction: { op: 'astore', arg: '2' } },
      { instruction: { op: 'aload', arg: '2' } },
      { instruction: { op: 'astore', arg: '3' } },
      { labelDef: 'LDONE:', instruction: { op: 'aload', arg: '3' } },
      { instruction: { op: 'bipush', arg: '1' } },
      { instruction: { op: 'bipush', arg: '2' } },
      { instruction: { op: 'invokevirtual', arg: ['Method', 'aja', ['a', '(II)V']] } },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(materializeCode(code), 1);
  t.deepEqual(code.codeItems.slice(4, 8).map((item) => item.instruction), [
    'aload_1',
    'astore_2',
    'aload_2',
    'astore_3',
  ]);
  t.end();
});

test('does not materialize concrete locals from the fallthrough branch before a forward target', (t) => {
  const code = {
    localsSize: '6',
    codeItems: [
      { instruction: { op: 'getstatic', arg: ['Field', 'Sprites', ['icons', '[Laja;']] } },
      { instruction: 'iconst_0' },
      { instruction: 'aaload' },
      { instruction: { op: 'astore', arg: '1' } },
      { instruction: 'iload_0' },
      { instruction: { op: 'ifeq', arg: 'LDONE' } },
      { instruction: { op: 'getstatic', arg: ['Field', 'Sprites', ['icons', '[Laja;']] } },
      { instruction: 'iconst_1' },
      { instruction: 'aaload' },
      { instruction: { op: 'astore', arg: '2' } },
      { instruction: { op: 'aload', arg: '2' } },
      { instruction: { op: 'astore', arg: '3' } },
      { labelDef: 'LDONE:', instruction: { op: 'aload', arg: '3' } },
      { instruction: { op: 'bipush', arg: '1' } },
      { instruction: { op: 'bipush', arg: '2' } },
      { instruction: { op: 'invokevirtual', arg: ['Method', 'aja', ['a', '(II)V']] } },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(materializeCode(code), 0);
  t.end();
});

test('materializes alias when the skipped branch jumps over refinement', (t) => {
  const code = {
    localsSize: '5',
    codeItems: [
      { instruction: { op: 'invokestatic', arg: ['Method', 'Debug', ['base', '()Ljava/lang/String;']] } },
      { instruction: { op: 'astore', arg: '1' } },
      { instruction: 'iload_0' },
      { instruction: { op: 'ifeq', arg: 'LREFINE' } },
      { instruction: { op: 'aload', arg: '1' } },
      { instruction: { op: 'astore', arg: '2' } },
      { instruction: { op: 'goto', arg: 'LJOIN' } },
      { labelDef: 'LREFINE:', instruction: { op: 'aload', arg: '1' } },
      { instruction: { op: 'invokestatic', arg: ['Method', 'Debug', ['refine', '(Ljava/lang/String;)Ljava/lang/String;']] } },
      { instruction: { op: 'astore', arg: '2' } },
      { instruction: { op: 'aload', arg: '2' } },
      { instruction: { op: 'astore', arg: '3' } },
      { labelDef: 'LJOIN:', instruction: { op: 'aload', arg: '3' } },
      { instruction: { op: 'invokestatic', arg: ['Method', 'Debug', ['draw', '(Ljava/lang/String;)V']] } },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(materializeCode(code), 1);
  t.deepEqual(code.codeItems.slice(2, 6).map((item) => item.instruction), [
    'aload_1',
    'astore_2',
    'aload_2',
    'astore_3',
  ]);
  t.end();
});

test('materializes target-branch string used by string-int static call', (t) => {
  const code = {
    localsSize: '5',
    codeItems: [
      { instruction: { op: 'getstatic', arg: ['Field', 'Text', ['label', 'Ljava/lang/String;']] } },
      { instruction: { op: 'astore', arg: '1' } },
      { instruction: 'iload_0' },
      { instruction: { op: 'ifne', arg: 'LREFINE' } },
      { instruction: { op: 'goto', arg: 'LJOIN' } },
      { labelDef: 'LREFINE:', instruction: { op: 'aload', arg: '1' } },
      { instruction: { op: 'invokestatic', arg: ['Method', 'Text', ['suffix', '(Ljava/lang/String;)Ljava/lang/String;']] } },
      { instruction: { op: 'astore', arg: '2' } },
      { labelDef: 'LJOIN:', instruction: { op: 'aload', arg: '2' } },
      { instruction: { op: 'bipush', arg: '-54' } },
      { instruction: { op: 'invokestatic', arg: ['Method', 'Draw', ['a', '(Ljava/lang/String;I)V']] } },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(materializeCode(code), 1);
  t.deepEqual(code.codeItems.slice(2, 4).map((item) => item.instruction), [
    'aload_1',
    'astore_2',
  ]);
  t.end();
});

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

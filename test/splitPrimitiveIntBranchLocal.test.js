'use strict';

const test = require('tape');
const { splitCode } = require('../src/passes/splitPrimitiveIntBranchLocal');

test('splits int local range used as array index loop after sibling branch store', (t) => {
  const code = {
    locals: '6',
    codeItems: [
      { instruction: 'iconst_0' },
      { instruction: { op: 'istore', arg: '3' } },
      { instruction: 'aload_0' },
      { instruction: { op: 'getfield', arg: ['Field', 'x', ['heads', '[I']] } },
      { instruction: 'iload_1' },
      { instruction: 'iaload' },
      { instruction: 'iload_2' },
      { instruction: 'iadd' },
      { instruction: { op: 'istore', arg: '3' } },
      { instruction: 'aload_0' },
      { instruction: { op: 'getfield', arg: ['Field', 'x', ['values', '[B']] } },
      { instruction: { op: 'iload', arg: '3' } },
      { instruction: 'baload' },
      { instruction: 'istore_1' },
      { labelDef: 'Lloop:', instruction: { op: 'iload', arg: '3' } },
      { instruction: 'aload_0' },
      { instruction: { op: 'getfield', arg: ['Field', 'x', ['heads', '[I']] } },
      { instruction: 'iload_1' },
      { instruction: 'iaload' },
      { instruction: { op: 'if_icmple', arg: 'Ldone' } },
      { instruction: 'aload_0' },
      { instruction: { op: 'getfield', arg: ['Field', 'x', ['values', '[B']] } },
      { instruction: { op: 'iload', arg: '3' } },
      { instruction: 'aload_0' },
      { instruction: { op: 'getfield', arg: ['Field', 'x', ['values', '[B']] } },
      { instruction: { op: 'iload', arg: '3' } },
      { instruction: 'iconst_1' },
      { instruction: 'isub' },
      { instruction: 'baload' },
      { instruction: 'bastore' },
      { instruction: { op: 'iinc', varnum: '3', incr: '-1' } },
      { instruction: { op: 'goto', arg: 'Lloop' } },
      { labelDef: 'Ldone:', instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(splitCode(code), 1);
  t.equal(code.locals, '7');
  t.deepEqual(code.codeItems[8].instruction, { op: 'istore', arg: '6' });
  t.deepEqual(code.codeItems[9].instruction, { op: 'iload', arg: '6' });
  t.equal(code.codeItems[10].instruction, 'istore_3');
  t.deepEqual(code.codeItems[13].instruction, { op: 'iload', arg: '6' });
  t.deepEqual(code.codeItems[16].instruction, { op: 'iload', arg: '6' });
  t.deepEqual(code.codeItems[24].instruction, { op: 'iload', arg: '6' });
  t.deepEqual(code.codeItems[27].instruction, { op: 'iload', arg: '6' });
  t.equal(code.codeItems[32].instruction.varnum, '6');
  t.end();
});

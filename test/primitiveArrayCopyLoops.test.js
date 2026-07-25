'use strict';

const test = require('tape');
const { rewriteCode } = require('../src/passes/primitiveArrayCopyLoops');

test('rewrites simple int array field copy loop', (t) => {
  const code = {
    stackSize: '4',
    codeItems: [
      { instruction: 'aload_0' },
      { instruction: { op: 'getfield', arg: ['Field', 'A', ['src', '[I']] } },
      { instruction: 'arraylength' },
      { instruction: 'istore_2' },
      { instruction: 'iconst_0' },
      { instruction: 'istore_3' },
      { labelDef: 'L0:', instruction: 'iload_3' },
      { instruction: 'iload_2' },
      { instruction: { op: 'if_icmpge', arg: 'L1' } },
      { instruction: 'aload_1' },
      { instruction: { op: 'getfield', arg: ['Field', 'A', ['dst', '[I']] } },
      { instruction: 'iload_3' },
      { instruction: 'aload_0' },
      { instruction: { op: 'getfield', arg: ['Field', 'A', ['src', '[I']] } },
      { instruction: 'iload_3' },
      { instruction: 'iaload' },
      { instruction: 'iastore' },
      { instruction: { op: 'iinc', arg: ['3', '1'] } },
      { instruction: { op: 'goto', arg: 'L0' } },
      { labelDef: 'L1:', instruction: 'return' },
    ],
  };

  t.equal(rewriteCode(code), 1);
  t.ok(code.codeItems.some((item) => item.instruction && item.instruction.op === 'invokestatic'), 'inserts invokestatic');
  t.equal(code.stackSize, '5');
  t.end();
});

test('rejects mismatched primitive descriptors', (t) => {
  const code = {
    codeItems: [
      { instruction: 'aload_0' },
      { instruction: { op: 'getfield', arg: ['Field', 'A', ['src', '[I']] } },
      { instruction: 'arraylength' },
      { instruction: 'istore_2' },
      { instruction: 'iconst_0' },
      { instruction: 'istore_3' },
      { labelDef: 'L0:', instruction: 'iload_3' },
      { instruction: 'iload_2' },
      { instruction: { op: 'if_icmpge', arg: 'L1' } },
      { instruction: 'aload_1' },
      { instruction: { op: 'getfield', arg: ['Field', 'A', ['dst', '[B']] } },
      { instruction: 'iload_3' },
      { instruction: 'aload_0' },
      { instruction: { op: 'getfield', arg: ['Field', 'A', ['src', '[I']] } },
      { instruction: 'iload_3' },
      { instruction: 'iaload' },
      { instruction: 'iastore' },
      { instruction: { op: 'iinc', arg: ['3', '1'] } },
      { instruction: { op: 'goto', arg: 'L0' } },
      { labelDef: 'L1:', instruction: 'return' },
    ],
  };

  t.equal(rewriteCode(code), 0);
  t.end();
});

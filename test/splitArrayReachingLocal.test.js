'use strict';

const test = require('tape');
const { splitCode } = require('../src/passes/splitArrayReachingLocal');

test('duplicates array reaching definition into fresh local', (t) => {
  const code = {
    localsSize: '5',
    stackSize: '1',
    codeItems: [
      { labelDef: 'L0:', instruction: { op: 'invokestatic', arg: ['Method', 'b', ['h', '(I)[I']] } },
      { labelDef: 'L1:', instruction: { op: 'astore', arg: '4' } },
      { labelDef: 'L2:', instruction: { op: 'aload', arg: '4' } },
      { instruction: 'iload_1' },
      { instruction: 'iconst_1' },
      { instruction: 'iastore' },
      { labelDef: 'L6:', instruction: { op: 'checkcast', arg: 'f' } },
      { labelDef: 'L7:', instruction: { op: 'astore', arg: '4' } },
      { labelDef: 'L8:', instruction: { op: 'aload', arg: '4' } },
      { instruction: { op: 'putfield', arg: ['Field', 'f', ['f_u', 'Z']] } },
    ],
    exceptionTable: [],
  };

  t.equal(splitCode(code), 1);
  t.equal(code.localsSize, '6');
  t.equal(code.stackSize, '2');
  t.equal(code.codeItems[1].instruction, 'dup');
  t.deepEqual(code.codeItems[2].instruction, { op: 'astore', arg: '5' });
  t.deepEqual(code.codeItems[3].instruction, { op: 'astore', arg: '4' });
  t.deepEqual(code.codeItems[4].instruction, { op: 'aload', arg: '5' });
  t.deepEqual(code.codeItems[10].instruction, { op: 'aload', arg: '4' });
  t.end();
});

test('refuses array use with ambiguous reaching definitions', (t) => {
  const code = {
    localsSize: '4',
    codeItems: [
      { labelDef: 'L0:', instruction: 'aload_0' },
      { instruction: { op: 'ifnull', arg: 'L10' } },
      { labelDef: 'L2:', instruction: 'aload_1' },
      { instruction: 'astore_3' },
      { instruction: { op: 'goto', arg: 'L12' } },
      { labelDef: 'L10:', instruction: 'aload_2' },
      { instruction: 'astore_3' },
      { labelDef: 'L12:', instruction: 'aload_3' },
      { instruction: 'arraylength' },
      { instruction: 'pop' },
      { labelDef: 'L20:', instruction: 'aload_0' },
      { instruction: 'astore_3' },
    ],
    exceptionTable: [],
  };

  t.equal(splitCode(code), 0);
  t.equal(code.localsSize, '4');
  t.end();
});

test('does not split handler exception stores', (t) => {
  const code = {
    localsSize: '2',
    codeItems: [
      { labelDef: 'H:', instruction: 'astore_1' },
      { instruction: 'aload_1' },
      { instruction: 'athrow' },
    ],
    exceptionTable: [
      { startLbl: 'L0', endLbl: 'L1', handlerLbl: 'H', catch_type: 'any' },
    ],
  };

  t.equal(splitCode(code), 0);
  t.equal(code.localsSize, '2');
  t.end();
});

test('splits simple int array aliases when a large method has many candidates', (t) => {
  const code = {
    localsSize: '6',
    stackSize: '1',
    codeItems: [
      { labelDef: 'L0:', instruction: { op: 'invokestatic', arg: ['Method', 'b', ['h', '(I)[I']] } },
      { instruction: 'astore_3' },
      { instruction: 'aload_3' },
      { instruction: { op: 'astore', arg: '4' } },
      { instruction: { op: 'getstatic', arg: ['Field', 'o', ['o_g', '[I']] } },
      { instruction: { op: 'astore', arg: '5' } },
      { instruction: { op: 'aload', arg: '4' } },
      { instruction: 'iload_1' },
      { instruction: { op: 'aload', arg: '5' } },
      { instruction: 'iload_1' },
      { instruction: 'iaload' },
      { instruction: 'iastore' },
      { instruction: { op: 'getstatic', arg: ['Field', 'j', ['j_d', '[I']] } },
      { instruction: { op: 'astore', arg: '4' } },
      { instruction: 'aload_3' },
      { instruction: { op: 'astore', arg: '5' } },
      { instruction: { op: 'aload', arg: '4' } },
      { instruction: 'iload_1' },
      { instruction: { op: 'aload', arg: '5' } },
      { instruction: 'iload_1' },
      { instruction: 'iaload' },
      { instruction: 'iastore' },
    ],
    exceptionTable: [],
  };

  t.equal(splitCode(code), 4);
  t.equal(code.localsSize, '10');
  t.equal(code.stackSize, '2');
  const loads = code.codeItems
    .map((item) => item.instruction)
    .filter((instruction) => instruction && typeof instruction === 'object' && instruction.op === 'aload')
    .map((instruction) => instruction.arg);
  t.ok(loads.includes('6'));
  t.ok(loads.includes('7'));
  t.ok(loads.includes('8'));
  t.ok(loads.includes('9'));
  t.end();
});

test('moves primitive array store to fresh local for non-array direct uses', (t) => {
  const code = {
    localsSize: '4',
    stackSize: '1',
    codeItems: [
      { labelDef: 'L0:', instruction: 'aload_0' },
      { instruction: { op: 'astore', arg: '3' } },
      { instruction: 'iconst_4' },
      { instruction: { op: 'newarray', arg: 'byte' } },
      { instruction: { op: 'astore', arg: '3' } },
      { instruction: { op: 'aload', arg: '3' } },
      { instruction: { op: 'invokestatic', arg: ['Method', 'x', ['use', '([B)V']] } },
      { instruction: 'aload_0' },
      { instruction: { op: 'astore', arg: '3' } },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(splitCode(code), 1);
  t.equal(code.localsSize, '5');
  t.equal(code.stackSize, '1');
  t.deepEqual(code.codeItems[4].instruction, { op: 'astore', arg: '4' });
  t.deepEqual(code.codeItems[5].instruction, { op: 'aload', arg: '4' });
  t.deepEqual(code.codeItems[8].instruction, { op: 'astore', arg: '3' });
  t.end();
});

test('does not move primitive array stores from locals also written as primitives', (t) => {
  const code = {
    localsSize: '4',
    stackSize: '1',
    codeItems: [
      { labelDef: 'L0:', instruction: 'iconst_0' },
      { instruction: { op: 'istore', arg: '3' } },
      { instruction: 'iconst_4' },
      { instruction: { op: 'newarray', arg: 'byte' } },
      { instruction: { op: 'astore', arg: '3' } },
      { instruction: { op: 'aload', arg: '3' } },
      { instruction: { op: 'invokestatic', arg: ['Method', 'x', ['use', '([B)V']] } },
      { instruction: 'aload_0' },
      { instruction: { op: 'astore', arg: '3' } },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(splitCode(code), 0);
  t.equal(code.localsSize, '4');
  t.end();
});

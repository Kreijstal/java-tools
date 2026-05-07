'use strict';

const test = require('tape');
const { splitCode } = require('../src/splitArrayReachingLocal');

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

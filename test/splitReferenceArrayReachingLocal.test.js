'use strict';

const test = require('tape');
const { splitCode } = require('../src/passes/splitReferenceArrayReachingLocal');

test('moves reference array store to fresh local before primitive array reuse', (t) => {
  const code = {
    localsSize: '7',
    stackSize: '4',
    codeItems: [
      { labelDef: 'L0:', instruction: 'iconst_2' },
      { instruction: { op: 'anewarray', arg: 'pi' } },
      { instruction: { op: 'astore', arg: '6' } },
      { instruction: { op: 'aload', arg: '6' } },
      { instruction: 'iconst_0' },
      { instruction: 'aload_2' },
      { instruction: 'iconst_0' },
      { instruction: 'aaload' },
      { instruction: 'aastore' },
      { instruction: { op: 'aload', arg: '6' } },
      { instruction: { op: 'astore', arg: '5' } },
      { instruction: 'iconst_2' },
      { instruction: { op: 'newarray', arg: 'int' } },
      { instruction: { op: 'astore', arg: '6' } },
      { instruction: { op: 'aload', arg: '6' } },
      { instruction: 'iconst_0' },
      { instruction: 'iconst_1' },
      { instruction: 'iastore' },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(splitCode(code), 1);
  t.equal(code.localsSize, '8');
  t.deepEqual(code.codeItems[2].instruction, { op: 'astore', arg: '7' });
  t.deepEqual(code.codeItems[3].instruction, { op: 'aload', arg: '7' });
  t.deepEqual(code.codeItems[10].instruction, { op: 'aload', arg: '7' });
  t.deepEqual(code.codeItems[8].instruction, { op: 'checkcast', arg: 'pi' });
  t.deepEqual(code.codeItems[14].instruction, { op: 'astore', arg: '6' });
  t.end();
});

test('does not move reference arrays used as arbitrary method arguments', (t) => {
  const code = {
    localsSize: '3',
    stackSize: '2',
    codeItems: [
      { labelDef: 'L0:', instruction: 'iconst_2' },
      { instruction: { op: 'anewarray', arg: 'pi' } },
      { instruction: { op: 'astore', arg: '2' } },
      { instruction: { op: 'aload', arg: '2' } },
      { instruction: { op: 'invokestatic', arg: ['Method', 'x', ['a', '([Ljava/lang/String;)V']] } },
      { instruction: 'iconst_2' },
      { instruction: { op: 'newarray', arg: 'int' } },
      { instruction: { op: 'astore', arg: '2' } },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(splitCode(code), 0);
  t.equal(code.localsSize, '3');
  t.end();
});

test('widens copied reference array to later consumer type', (t) => {
  const code = {
    localsSize: '7',
    stackSize: '4',
    codeItems: [
      { labelDef: 'L0:', instruction: 'iconst_2' },
      { instruction: { op: 'anewarray', arg: 'pi' } },
      { instruction: { op: 'astore', arg: '6' } },
      { instruction: { op: 'aload', arg: '6' } },
      { instruction: 'iconst_0' },
      { instruction: 'aload_2' },
      { instruction: 'iconst_0' },
      { instruction: 'aaload' },
      { instruction: 'aastore' },
      { instruction: { op: 'aload', arg: '6' } },
      { instruction: { op: 'astore', arg: '5' } },
      { instruction: 'iconst_2' },
      { instruction: { op: 'newarray', arg: 'int' } },
      { instruction: { op: 'astore', arg: '6' } },
      { instruction: 'aload_0' },
      { instruction: { op: 'aload', arg: '5' } },
      { instruction: { op: 'aload', arg: '6' } },
      { instruction: { op: 'invokevirtual', arg: ['Method', 'lm', ['a', '([Llc;[I)V']] } },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(splitCode(code), 1);
  t.deepEqual(code.codeItems[1].instruction, { op: 'anewarray', arg: 'lc' });
  t.deepEqual(code.codeItems[8].instruction, { op: 'checkcast', arg: 'lc' });
  t.end();
});

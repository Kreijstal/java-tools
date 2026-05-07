'use strict';

const test = require('tape');
const { rewriteCode } = require('../src/splitCastedLocalRange');

test('splits casted local range into a fresh local', (t) => {
  const code = {
    localsSize: '3',
    stackSize: '1',
    codeItems: [
      { instruction: { op: 'invokevirtual', arg: ['Method', 'vj', ['c', '(B)Lbh;']] } },
      { instruction: { op: 'checkcast', arg: 'fa' } },
      { instruction: 'astore_2' },
      { instruction: 'iload_1' },
      { instruction: 'aload_2' },
      { instruction: { op: 'invokestatic', arg: ['Method', 'w', ['a', '(IILfa;)V']] } },
      { instruction: { op: 'invokevirtual', arg: ['Method', 'vj', ['d', '(Z)Lbh;']] } },
      { instruction: { op: 'checkcast', arg: 'fa' } },
      { instruction: 'astore_2' },
    ],
  };

  t.equal(rewriteCode(code), 1);
  t.equal(code.localsSize, '4');
  t.equal(code.stackSize, '2');
  t.equal(code.codeItems[2].instruction, 'dup');
  t.equal(code.codeItems[3].instruction, 'astore_3');
  t.equal(code.codeItems[4].instruction, 'astore_2');
  t.equal(code.codeItems[6].instruction, 'aload_3');
  t.equal(code.codeItems[10].instruction, 'astore_2');
  t.end();
});

test('does not split object casts', (t) => {
  const code = {
    localsSize: '3',
    codeItems: [
      { instruction: { op: 'checkcast', arg: 'java/lang/Object' } },
      { instruction: 'astore_2' },
      { instruction: 'aload_2' },
      { instruction: 'astore_2' },
    ],
  };

  t.equal(rewriteCode(code), 0);
  t.equal(code.localsSize, '3');
  t.equal(code.codeItems[2].instruction, 'aload_2');
  t.end();
});

test('requires the cast source to be a bh-returning invocation', (t) => {
  const code = {
    localsSize: '3',
    codeItems: [
      { instruction: { op: 'invokevirtual', arg: ['Method', 'owner', ['next', '()Ljava/lang/Object;']] } },
      { instruction: { op: 'checkcast', arg: 'fa' } },
      { instruction: 'astore_2' },
      { instruction: 'aload_2' },
      { instruction: 'astore_2' },
    ],
  };

  t.equal(rewriteCode(code), 0);
  t.equal(code.localsSize, '3');
  t.equal(code.codeItems[3].instruction, 'aload_2');
  t.end();
});

test('skips large cast ranges', (t) => {
  const code = {
    localsSize: '3',
    codeItems: [
      { instruction: { op: 'invokevirtual', arg: ['Method', 'vj', ['c', '(B)Lbh;']] } },
      { instruction: { op: 'checkcast', arg: 'fa' } },
      { instruction: 'astore_2' },
      { instruction: 'aload_2' },
      ...Array.from({ length: 31 }, () => ({ instruction: 'nop' })),
      { instruction: 'astore_2' },
    ],
  };

  t.equal(rewriteCode(code), 0);
  t.equal(code.localsSize, '3');
  t.equal(code.codeItems[3].instruction, 'aload_2');
  t.end();
});

test('skips ranges that contain a backward branch before the store', (t) => {
  const code = {
    localsSize: '3',
    codeItems: [
      { labelDef: 'Loop:', instruction: 'aload_2' },
      { instruction: { op: 'ifnull', arg: 'Done' } },
      { instruction: { op: 'invokevirtual', arg: ['Method', 'vj', ['d', '(Z)Lbh;']] } },
      { instruction: { op: 'checkcast', arg: 've' } },
      { instruction: 'astore_2' },
      { instruction: { op: 'goto', arg: 'Loop' } },
      { labelDef: 'Done:', instruction: 'aload_2' },
      { instruction: { op: 'invokestatic', arg: ['Method', 'fm', ['a', '(BLbh;Lbh;)V']] } },
      { labelDef: 'Handler:', instruction: 'astore_2' },
    ],
  };

  t.equal(rewriteCode(code), 0);
  t.equal(code.localsSize, '3');
  t.equal(code.codeItems[6].instruction, 'aload_2');
  t.end();
});

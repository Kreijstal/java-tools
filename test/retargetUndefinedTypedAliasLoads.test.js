'use strict';

const test = require('tape');
const { rewriteCode } = require('../src/passes/retargetUndefinedTypedAliasLoads');

test('retargets undefined stale field receiver to recent checked alias', (t) => {
  const code = {
    codeItems: [
      { instruction: { op: 'aload', arg: '3' } },
      { instruction: { op: 'iload', arg: '8' } },
      { instruction: 'aaload' },
      { instruction: { op: 'checkcast', arg: 'ima' } },
      { instruction: { op: 'astore', arg: '30' } },
      { instruction: { op: 'aload', arg: '30' } },
      { instruction: { op: 'astore', arg: '30' } },
      { instruction: { op: 'aload', arg: '27' } },
      { instruction: { op: 'astore', arg: '9' } },
      { instruction: { op: 'aload', arg: '27' } },
      { instruction: { op: 'getfield', arg: ['Field', 'ima', ['ima_b', '[I']] } },
      { instruction: 'pop' },
      { instruction: { op: 'aload', arg: '27' } },
      { instruction: { op: 'getfield', arg: ['Field', 'ima', ['ima_a', '[B']] } },
      { instruction: 'pop' },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(rewriteCode(code), 3);
  t.deepEqual(code.codeItems[7].instruction, { op: 'aload', arg: '30' });
  t.deepEqual(code.codeItems[9].instruction, { op: 'aload', arg: '30' });
  t.deepEqual(code.codeItems[12].instruction, { op: 'aload', arg: '30' });
  t.end();
});

test('leaves defined locals alone', (t) => {
  const code = {
    codeItems: [
      { instruction: 'aconst_null' },
      { instruction: { op: 'astore', arg: '27' } },
      { instruction: { op: 'aload', arg: '3' } },
      { instruction: { op: 'iload', arg: '8' } },
      { instruction: 'aaload' },
      { instruction: { op: 'checkcast', arg: 'ima' } },
      { instruction: { op: 'astore', arg: '30' } },
      { instruction: { op: 'aload', arg: '27' } },
      { instruction: { op: 'getfield', arg: ['Field', 'ima', ['ima_b', '[I']] } },
      { instruction: 'pop' },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(rewriteCode(code), 0);
  t.deepEqual(code.codeItems[7].instruction, { op: 'aload', arg: '27' });
  t.end();
});

test('retargets undefined reference-array load to unique compatible parameter', (t) => {
  const method = {
    flags: [],
    descriptor: '([[I[IIB)[[I',
  };
  const code = {
    codeItems: [
      { instruction: { op: 'aload', arg: '22' } },
      { instruction: { op: 'iload', arg: '5' } },
      { instruction: 'aaload' },
      { instruction: { op: 'astore', arg: '23' } },
      { instruction: { op: 'aload', arg: '23' } },
      { instruction: 'arraylength' },
      { instruction: 'pop' },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(rewriteCode(code, method), 1);
  t.equal(code.codeItems[0].instruction, 'aload_1');
  t.end();
});

test('skips undefined array load when compatible parameter is ambiguous', (t) => {
  const method = {
    flags: [],
    descriptor: '([[I[[B)V',
  };
  const code = {
    codeItems: [
      { instruction: { op: 'aload', arg: '8' } },
      { instruction: 'iconst_0' },
      { instruction: 'aaload' },
      { instruction: 'pop' },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(rewriteCode(code, method), 0);
  t.deepEqual(code.codeItems[0].instruction, { op: 'aload', arg: '8' });
  t.end();
});

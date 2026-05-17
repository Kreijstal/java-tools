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

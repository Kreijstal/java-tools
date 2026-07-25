'use strict';

const test = require('tape');
const { splitCode } = require('../src/passes/splitTypedAliasCopyLocals');

test('split-typed-alias-copy-locals: splits concrete alias copy before polluted reuse', (t) => {
  const code = {
    localsSize: '5',
    codeItems: [
      { instruction: { op: 'invokestatic', arg: ['Method', 'Factory', ['make', '()LItem;']] } },
      { instruction: { op: 'astore', arg: '4' } },
      { instruction: { op: 'aload', arg: '4' } },
      { instruction: { op: 'astore', arg: '2' } },
      { instruction: { op: 'aload', arg: '4' } },
      { instruction: { op: 'getfield', arg: ['Field', 'Item', ['bounds', '[I']] } },
      { instruction: 'pop' },
      { instruction: { op: 'aload', arg: '2' } },
      { instruction: { op: 'invokestatic', arg: ['Method', 'Use', ['acceptBase', '(LBase;)V']] } },
      { instruction: { op: 'aload', arg: '0' } },
      { instruction: { op: 'getfield', arg: ['Field', 'Owner', ['crbs', '[LCrb;']] } },
      { instruction: { op: 'astore', arg: '2' } },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(splitCode(code), 1);
  t.equal(code.localsSize, '6');
  t.deepEqual(code.codeItems[1].instruction, { op: 'astore', arg: '5' });
  t.deepEqual(code.codeItems[2].instruction, { op: 'aload', arg: '5' });
  t.deepEqual(code.codeItems[3].instruction, { op: 'astore', arg: '5' });
  t.deepEqual(code.codeItems[4].instruction, { op: 'aload', arg: '5' });
  t.deepEqual(code.codeItems[7].instruction, { op: 'aload', arg: '5' });
  t.deepEqual(code.codeItems[11].instruction, { op: 'astore', arg: '2' });
  t.end();
});

test('split-typed-alias-copy-locals: skips unpolluted alias copies', (t) => {
  const code = {
    localsSize: '5',
    codeItems: [
      { instruction: { op: 'invokestatic', arg: ['Method', 'Factory', ['make', '()LItem;']] } },
      { instruction: { op: 'astore', arg: '4' } },
      { instruction: { op: 'aload', arg: '4' } },
      { instruction: { op: 'astore', arg: '2' } },
      { instruction: { op: 'aload', arg: '2' } },
      { instruction: { op: 'getfield', arg: ['Field', 'Item', ['bounds', '[I']] } },
      { instruction: 'pop' },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(splitCode(code), 0);
  t.equal(code.localsSize, '5');
  t.end();
});

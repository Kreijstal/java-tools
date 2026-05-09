'use strict';

const test = require('tape');
const { rewriteCode } = require('../src/castPrivateFieldReceivers');

test('casts receiver for private putfield with simple value', (t) => {
  const code = {
    methodFlags: ['static'],
    codeItems: [
      { instruction: { op: 'aload', arg: '4' } },
      { instruction: 'iload_3' },
      { instruction: { op: 'putfield', arg: ['Field', 'en', ['en_t', 'I']] } },
    ],
  };

  t.equal(rewriteCode(code, 'en', new Set(['en_t:I'])), 1);
  t.deepEqual(code.codeItems.map((item) => item.instruction), [
    { op: 'aload', arg: '4' },
    { op: 'checkcast', arg: 'en' },
    'iload_3',
    { op: 'putfield', arg: ['Field', 'en', ['en_t', 'I']] },
  ]);
  t.end();
});

test('casts receiver for private getfield', (t) => {
  const code = {
    methodFlags: ['static'],
    codeItems: [
      { instruction: { op: 'aload', arg: '4' } },
      { instruction: { op: 'getfield', arg: ['Field', 'en', ['en_c', 'I']] } },
    ],
  };

  t.equal(rewriteCode(code, 'en', new Set(['en_c:I'])), 1);
  t.equal(code.codeItems[1].instruction.op, 'checkcast');
  t.end();
});

test('leaves non-private fields alone', (t) => {
  const code = {
    methodFlags: ['static'],
    codeItems: [
      { instruction: { op: 'aload', arg: '4' } },
      { instruction: 'iload_3' },
      { instruction: { op: 'putfield', arg: ['Field', 'en', ['en_k', '[I']] } },
    ],
  };

  t.equal(rewriteCode(code, 'en', new Set(['en_t:I'])), 0);
  t.equal(code.codeItems.length, 3);
  t.end();
});

test('leaves instance methods alone', (t) => {
  const code = {
    methodFlags: [],
    codeItems: [
      { instruction: 'aload_0' },
      { instruction: { op: 'getfield', arg: ['Field', 'en', ['en_c', 'I']] } },
    ],
  };

  t.equal(rewriteCode(code, 'en', new Set(['en_c:I'])), 0);
  t.equal(code.codeItems.length, 2);
  t.end();
});

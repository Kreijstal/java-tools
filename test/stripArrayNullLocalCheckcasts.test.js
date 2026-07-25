'use strict';

const test = require('tape');
const { rewriteCode } = require('../src/passes/stripArrayNullLocalCheckcasts');

test('strips array null checkcast when a later concrete array store fixes the local type', (t) => {
  const code = {
    codeItems: [
      { instruction: 'aconst_null' },
      { instruction: { op: 'checkcast', arg: '[[F' } },
      { instruction: { op: 'astore', arg: '7' } },
      { instruction: 'iconst_4' },
      { instruction: { op: 'anewarray', arg: '[F' } },
      { instruction: { op: 'astore', arg: '7' } },
      { instruction: { op: 'aload', arg: '7' } },
      { instruction: 'iconst_0' },
      { instruction: 'aconst_null' },
      { instruction: 'aastore' },
      { instruction: 'return' },
    ],
  };

  t.equal(rewriteCode(code), 1);
  t.deepEqual(code.codeItems.map((item) => item.instruction), [
    'aconst_null',
    { op: 'astore', arg: '7' },
    'iconst_4',
    { op: 'anewarray', arg: '[F' },
    { op: 'astore', arg: '7' },
    { op: 'aload', arg: '7' },
    'iconst_0',
    'aconst_null',
    'aastore',
    'return',
  ]);
  t.end();
});

test('keeps non-array null local checkcast', (t) => {
  const code = {
    codeItems: [
      { instruction: 'aconst_null' },
      { instruction: { op: 'checkcast', arg: 'java/lang/String' } },
      { instruction: { op: 'astore', arg: '1' } },
      { instruction: 'return' },
    ],
  };

  t.equal(rewriteCode(code), 0);
  t.deepEqual(code.codeItems[1].instruction, { op: 'checkcast', arg: 'java/lang/String' });
  t.end();
});

test('keeps array null checkcast without a matching later array store', (t) => {
  const code = {
    codeItems: [
      { instruction: 'aconst_null' },
      { instruction: { op: 'checkcast', arg: '[[F' } },
      { instruction: { op: 'astore', arg: '7' } },
      { instruction: 'iconst_4' },
      { instruction: { op: 'newarray', arg: 'int' } },
      { instruction: { op: 'astore', arg: '7' } },
      { instruction: 'return' },
    ],
  };

  t.equal(rewriteCode(code), 0);
  t.deepEqual(code.codeItems[1].instruction, { op: 'checkcast', arg: '[[F' });
  t.end();
});

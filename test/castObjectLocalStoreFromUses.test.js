'use strict';

const test = require('tape');
const { rewriteCode } = require('../src/castObjectLocalStoreFromUses');

test('casts object local store based on later field reads', (t) => {
  const code = {
    codeItems: [
      { labelDef: 'L0:', instruction: { op: 'aload', arg: '0' } },
      { instruction: 'iconst_0' },
      { instruction: 'aaload' },
      { instruction: { op: 'astore', arg: '2' } },
      { instruction: { op: 'aload', arg: '2' } },
      { instruction: { op: 'getfield', arg: ['Field', 'ck', ['K', 'I']] } },
      { instruction: 'pop' },
      { instruction: 'aconst_null' },
      { instruction: { op: 'astore', arg: '2' } },
      { instruction: 'aconst_null' },
      { instruction: { op: 'astore', arg: '2' } },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(rewriteCode(code), 1);
  t.deepEqual(code.codeItems[3].instruction, { op: 'checkcast', arg: 'ck' });
  t.deepEqual(code.codeItems[4].instruction, { op: 'astore', arg: '2' });
  t.end();
});

test('does not cast when uses imply different types', (t) => {
  const code = {
    codeItems: [
      { labelDef: 'L0:', instruction: { op: 'aload', arg: '0' } },
      { instruction: 'iconst_0' },
      { instruction: 'aaload' },
      { instruction: { op: 'astore', arg: '2' } },
      { instruction: { op: 'aload', arg: '2' } },
      { instruction: { op: 'getfield', arg: ['Field', 'ck', ['K', 'I']] } },
      { instruction: 'pop' },
      { instruction: { op: 'aload', arg: '2' } },
      { instruction: { op: 'getfield', arg: ['Field', 'lk', ['lk_jb', 'I']] } },
      { instruction: 'pop' },
      { instruction: 'aconst_null' },
      { instruction: { op: 'astore', arg: '2' } },
      { instruction: 'aconst_null' },
      { instruction: { op: 'astore', arg: '2' } },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(rewriteCode(code), 0);
  t.end();
});

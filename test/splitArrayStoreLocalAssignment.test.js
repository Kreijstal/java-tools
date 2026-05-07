'use strict';

const test = require('tape');
const { rewriteCode } = require('../src/splitArrayStoreLocalAssignment');

test('moves local assignment before array store', (t) => {
  const code = {
    codeItems: [
      { instruction: 'aload_0' },
      { instruction: { op: 'getfield', arg: ['Field', 'ng', ['ng_h', '[Lbh;']] } },
      { instruction: 'iload_2' },
      { instruction: { op: 'new', arg: 'bh' } },
      { instruction: 'dup' },
      { instruction: { op: 'invokespecial', arg: ['Method', 'bh', ['<init>', '()V']] } },
      { instruction: 'dup_x2' },
      { instruction: 'aastore' },
      { instruction: 'astore_3' },
      { instruction: 'aload_3' },
      { instruction: 'aload_3' },
      { instruction: { op: 'checkcast', arg: 'bh' } },
      { instruction: { op: 'putfield', arg: ['Field', 'bh', ['bh_b', 'Lbh;']] } },
    ],
  };

  t.equal(rewriteCode(code), 1);
  t.equal(code.codeItems[6].instruction, 'dup');
  t.equal(code.codeItems[7].instruction, 'astore_3');
  t.equal(code.codeItems[8].instruction, 'aastore');
  t.end();
});

test('keeps array store when local is not immediately self-stored', (t) => {
  const code = {
    codeItems: [
      { instruction: 'dup_x2' },
      { instruction: 'aastore' },
      { instruction: 'astore_3' },
      { instruction: 'aload_3' },
      { instruction: { op: 'putfield', arg: ['Field', 'bh', ['bh_b', 'Lbh;']] } },
    ],
  };

  t.equal(rewriteCode(code), 0);
  t.equal(code.codeItems[0].instruction, 'dup_x2');
  t.end();
});

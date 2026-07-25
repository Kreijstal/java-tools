'use strict';

const test = require('tape');
const { castCode } = require('../src/passes/castInvokeReceiversToOwners');

test('cast-invoke-receivers-to-owners: casts local receiver to invokeinterface owner', (t) => {
  const code = {
    localsSize: '4',
    codeItems: [
      { instruction: { op: 'aload', arg: '2' } },
      { instruction: { op: 'aload', arg: '3' } },
      { instruction: { op: 'bipush', arg: '-105' } },
      { instruction: { op: 'invokeinterface', arg: ['InterfaceMethod', 'Utb', ['a', '(LFaa;B)V']] } },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(castCode(code), 1);
  t.deepEqual(code.codeItems[1].instruction, { op: 'checkcast', arg: 'Utb' });
  t.deepEqual(code.codeItems[2].instruction, { op: 'aload', arg: '3' });
  t.end();
});

test('cast-invoke-receivers-to-owners: skips existing owner cast', (t) => {
  const code = {
    localsSize: '4',
    codeItems: [
      { instruction: { op: 'aload', arg: '2' } },
      { instruction: { op: 'checkcast', arg: 'Utb' } },
      { instruction: { op: 'aload', arg: '3' } },
      { instruction: { op: 'bipush', arg: '-105' } },
      { instruction: { op: 'invokeinterface', arg: ['InterfaceMethod', 'Utb', ['a', '(LFaa;B)V']] } },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(castCode(code), 0);
  t.equal(code.codeItems.length, 6);
  t.end();
});

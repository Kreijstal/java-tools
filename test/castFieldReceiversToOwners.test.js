'use strict';

const test = require('tape');
const { castCode } = require('../src/passes/castFieldReceiversToOwners');

test('cast-field-receivers-to-owners: casts local receiver to getfield owner', (t) => {
  const code = {
    localsSize: '2',
    codeItems: [
      { instruction: { op: 'aload', arg: '1' } },
      { instruction: { op: 'getfield', arg: ['Field', 'opa', ['opa_q', 'I']] } },
      { instruction: 'ireturn' },
    ],
    exceptionTable: [],
  };

  t.equal(castCode(code), 1);
  t.deepEqual(code.codeItems[1].instruction, { op: 'checkcast', arg: 'opa' });
  t.deepEqual(code.codeItems[2].instruction, { op: 'getfield', arg: ['Field', 'opa', ['opa_q', 'I']] });
  t.end();
});

test('cast-field-receivers-to-owners: skips existing owner cast', (t) => {
  const code = {
    localsSize: '2',
    codeItems: [
      { instruction: { op: 'aload', arg: '1' } },
      { instruction: { op: 'checkcast', arg: 'opa' } },
      { instruction: { op: 'getfield', arg: ['Field', 'opa', ['opa_q', 'I']] } },
      { instruction: 'ireturn' },
    ],
    exceptionTable: [],
  };

  t.equal(castCode(code), 0);
  t.equal(code.codeItems.length, 4);
  t.end();
});

test('cast-field-receivers-to-owners: skips non-concrete owners', (t) => {
  const code = {
    localsSize: '2',
    codeItems: [
      { instruction: { op: 'aload', arg: '1' } },
      { instruction: { op: 'getfield', arg: ['Field', 'java/lang/Object', ['value', 'I']] } },
      { instruction: 'ireturn' },
    ],
    exceptionTable: [],
  };

  t.equal(castCode(code), 0);
  t.equal(code.codeItems.length, 3);
  t.end();
});

test('cast-field-receivers-to-owners: skips this receiver for current class fields', (t) => {
  const code = {
    localsSize: '1',
    codeItems: [
      { instruction: 'aload_0' },
      { instruction: { op: 'getfield', arg: ['Field', 'roa', ['roa_s', 'I']] } },
      { instruction: 'ireturn' },
    ],
    exceptionTable: [],
  };

  t.equal(castCode(code, { currentClass: 'roa' }), 0);
  t.equal(code.codeItems.length, 3);
  t.end();
});

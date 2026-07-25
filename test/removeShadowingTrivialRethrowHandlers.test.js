'use strict';

const test = require('tape');
const { removeFromCode, isPureRethrowBlock } = require('../src/passes/removeShadowingTrivialRethrowHandlers');

test('isPureRethrowBlock accepts astore aload athrow', (t) => {
  t.equal(isPureRethrowBlock([
    { labelDef: 'H1:' },
    { instruction: { op: 'astore', arg: '2' } },
    { instruction: { op: 'aload', arg: '2' } },
    { instruction: 'athrow' },
  ]), true);
  t.end();
});

test('removes earlier duplicate-range trivial rethrow handler', (t) => {
  const code = {
    codeItems: [
      { labelDef: 'L0:', instruction: 'aload_0' },
      { labelDef: 'L1:', instruction: 'return' },
      { labelDef: 'H1:', instruction: 'astore_2' },
      { instruction: 'aload_2' },
      { instruction: 'athrow' },
      { labelDef: 'H2:', instruction: 'astore_2' },
      { instruction: 'aload_1' },
      { instruction: 'iconst_2' },
      { instruction: { op: 'putfield', arg: ['Field', 'mh', ['mh_c', 'I']] } },
      { instruction: 'return' },
    ],
    exceptionTable: [
      { startLbl: 'L0', endLbl: 'L1', handlerLbl: 'H1', catch_type: 'any' },
      { startLbl: 'L0', endLbl: 'L1', handlerLbl: 'H2', catch_type: 'any' },
    ],
  };

  const result = removeFromCode(code);
  t.equal(result.removals.length, 1);
  t.deepEqual(code.exceptionTable, [
    { startLbl: 'L0', endLbl: 'L1', handlerLbl: 'H2', catch_type: 'any' },
  ]);
  t.end();
});

test('keeps handler with side effects', (t) => {
  const code = {
    codeItems: [
      { labelDef: 'L0:', instruction: 'return' },
      { labelDef: 'L1:' },
      { labelDef: 'H1:', instruction: 'astore_2' },
      { instruction: 'aload_0' },
      { instruction: 'athrow' },
      { labelDef: 'H2:', instruction: 'astore_2' },
      { instruction: 'return' },
    ],
    exceptionTable: [
      { startLbl: 'L0', endLbl: 'L1', handlerLbl: 'H1', catch_type: 'any' },
      { startLbl: 'L0', endLbl: 'L1', handlerLbl: 'H2', catch_type: 'any' },
    ],
  };

  t.equal(removeFromCode(code).removals.length, 0);
  t.equal(code.exceptionTable.length, 2);
  t.end();
});

'use strict';

const test = require('tape');
const { inlineMethod } = require('../src/passes/inlineGotoReturnIsland');

test('inlines isolated protected return island reached by one goto', (t) => {
  const code = {
    codeItems: [
      { labelDef: 'L0:', instruction: 'aload_0' },
      { labelDef: 'L17:', instruction: { op: 'ifnull', arg: 'L26' } },
      { labelDef: 'L20:', instruction: { op: 'goto', arg: 'L28' } },
      { labelDef: 'L26:', instruction: 'iconst_0' },
      { labelDef: 'L27:', instruction: 'ireturn' },
      { labelDef: 'L28:', instruction: 'iconst_1' },
      { labelDef: 'L29:', instruction: 'ireturn' },
      { labelDef: 'L30:', instruction: 'astore_2' },
      { instruction: 'aload_2' },
      { instruction: 'athrow' },
    ],
    exceptionTable: [
      { startLbl: 'L0', endLbl: 'L27', handlerLbl: 'L30', catch_type: 'any' },
      { startLbl: 'L28', endLbl: 'L29', handlerLbl: 'L30', catch_type: 'any' },
    ],
  };

  t.equal(inlineMethod(code, {}), 1);
  t.deepEqual(code.codeItems.map((item) => item.labelDef || null), [
    'L0:', 'L17:', 'L20:', null, 'L26:', 'L27:', 'L30:', null, null,
  ]);
  t.deepEqual(code.codeItems.map((item) => item.instruction), [
    'aload_0',
    { op: 'ifnull', arg: 'L26' },
    'iconst_1',
    'ireturn',
    'iconst_0',
    'ireturn',
    'astore_2',
    'aload_2',
    'athrow',
  ]);
  t.deepEqual(code.exceptionTable, [
    { startLbl: 'L0', endLbl: 'L27', handlerLbl: 'L30', catch_type: 'any' },
  ]);
  t.end();
});

test('keeps shared return island with multiple branch predecessors', (t) => {
  const code = {
    codeItems: [
      { labelDef: 'L0:', instruction: { op: 'goto', arg: 'L10' } },
      { labelDef: 'L1:', instruction: { op: 'goto', arg: 'L10' } },
      { labelDef: 'L10:', instruction: 'iconst_1' },
      { labelDef: 'L11:', instruction: 'ireturn' },
    ],
    exceptionTable: [
      { startLbl: 'L10', endLbl: 'L11', handlerLbl: 'L20', catch_type: 'any' },
    ],
  };

  t.equal(inlineMethod(code, {}), 0);
  t.equal(code.codeItems.length, 4);
  t.end();
});

test('keeps island when goto and target have different handler sets', (t) => {
  const code = {
    codeItems: [
      { labelDef: 'L84:', instruction: 'iload_0' },
      { labelDef: 'L96:', instruction: { op: 'goto', arg: 'L103' } },
      { labelDef: 'L102:', instruction: 'areturn' },
      { labelDef: 'L103:', instruction: 'getstatic' },
      { labelDef: 'L106:', instruction: 'areturn' },
      { labelDef: 'L107:', instruction: 'astore_2' },
      { labelDef: 'L111:', instruction: 'areturn' },
      { labelDef: 'L112:', instruction: 'astore_2' },
      { instruction: 'athrow' },
    ],
    exceptionTable: [
      { startLbl: 'L84', endLbl: 'L102', handlerLbl: 'L107', catch_type: 'any' },
      { startLbl: 'L84', endLbl: 'L102', handlerLbl: 'L112', catch_type: 'any' },
      { startLbl: 'L103', endLbl: 'L106', handlerLbl: 'L112', catch_type: 'any' },
    ],
  };

  t.equal(inlineMethod(code, {}), 0);
  t.equal(code.codeItems[1].instruction.arg, 'L103');
  t.end();
});

test('keeps bridge goto that starts its own catch range', (t) => {
  const code = {
    codeItems: [
      { labelDef: 'L96:', instruction: { op: 'goto', arg: 'L103' } },
      { labelDef: 'L102:', instruction: 'areturn' },
      { labelDef: 'L103:', instruction: { op: 'goto', arg: 'L111' } },
      { labelDef: 'L107:', instruction: 'astore_2' },
      { labelDef: 'L110:', instruction: 'areturn' },
      { labelDef: 'L111:', instruction: 'getstatic' },
      { labelDef: 'L114:', instruction: 'areturn' },
      { labelDef: 'L115:', instruction: 'astore_2' },
      { instruction: 'athrow' },
    ],
    exceptionTable: [
      { startLbl: 'L96', endLbl: 'L102', handlerLbl: 'L107', catch_type: 'any' },
      { startLbl: 'L103', endLbl: 'L110', handlerLbl: 'L115', catch_type: 'any' },
      { startLbl: 'L111', endLbl: 'L114', handlerLbl: 'L115', catch_type: 'any' },
    ],
  };

  t.equal(inlineMethod(code, {}), 0);
  t.deepEqual(code.codeItems[2].instruction, { op: 'goto', arg: 'L111' });
  t.end();
});

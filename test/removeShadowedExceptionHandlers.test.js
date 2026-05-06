'use strict';

const test = require('tape');
const { runRemoveShadowedExceptionHandlers } = require('../src/removeShadowedExceptionHandlers');

function createAst() {
  return {
    classes: [
      {
        className: 'Trap',
        items: [
          {
            type: 'method',
            method: {
              name: 'f',
              descriptor: '()V',
              attributes: [
                {
                  type: 'code',
                  code: {
                    codeItems: [],
                    exceptionTable: [
                      { startLbl: 'L0', endLbl: 'L10', handlerLbl: 'L20', catch_type: 'any' },
                      { startLbl: 'L0', endLbl: 'L10', handlerLbl: 'L30', catch_type: 'any' },
                      { startLbl: 'L0', endLbl: 'L10', handlerLbl: 'L40', catch_type: 'java/lang/RuntimeException' },
                      { startLbl: 'L1', endLbl: 'L10', handlerLbl: 'L50', catch_type: 'any' },
                    ],
                    attributes: [],
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

test('runRemoveShadowedExceptionHandlers removes later identical range/type handlers', (t) => {
  const ast = createAst();
  const result = runRemoveShadowedExceptionHandlers(ast);
  const table = ast.classes[0].items[0].method.attributes[0].code.exceptionTable;

  t.ok(result.changed, 'reports a change');
  t.equal(result.removed, 1, 'removes one shadowed handler');
  t.equal(table.length, 3, 'keeps non-shadowed entries');
  t.deepEqual(table.map((entry) => entry.handlerLbl), ['L20', 'L40', 'L50'], 'keeps the first matching handler');
  t.equal(result.removals[0].handlerLabel, 'L30', 'reports removed handler');
  t.equal(result.removals[0].shadowedByHandlerLabel, 'L20', 'reports shadowing handler');
  t.end();
});

test('runRemoveShadowedExceptionHandlers leaves unique exception ranges unchanged', (t) => {
  const ast = createAst();
  const table = ast.classes[0].items[0].method.attributes[0].code.exceptionTable;
  table.splice(1, 1);

  const result = runRemoveShadowedExceptionHandlers(ast);
  t.notOk(result.changed, 'reports no change');
  t.equal(table.length, 3, 'table is unchanged');
  t.end();
});

test('runRemoveShadowedExceptionHandlers can be scoped to selected methods', (t) => {
  const ast = createAst();
  const result = runRemoveShadowedExceptionHandlers(ast, { methodKeys: new Set(['Trap.g()V']) });
  const table = ast.classes[0].items[0].method.attributes[0].code.exceptionTable;

  t.notOk(result.changed, 'reports no change outside selected methods');
  t.equal(table.length, 4, 'table is unchanged');
  t.end();
});

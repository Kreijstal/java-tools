'use strict';

const test = require('tape');
const { removeTrivialRethrowHandlers } = require('../src/removeTrivialRethrowHandlers');

function createTrapAst() {
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
                    codeItems: [
                      { pc: 0, labelDef: 'L0:', instruction: { op: 'goto', arg: 'L2' } },
                      { pc: 1, labelDef: 'L1:', instruction: 'athrow' },
                      { pc: 2, labelDef: 'L2:', instruction: 'return' },
                    ],
                    exceptionTable: [
                      {
                        start_pc: 0,
                        end_pc: 1,
                        handler_pc: 1,
                        catch_type: 'java/lang/RuntimeException',
                        startLbl: 'L0',
                        endLbl: 'L1',
                        handlerLbl: 'L1',
                      },
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

test('removeTrivialRethrowHandlers removes exception-table trap and dead athrow', (t) => {
  const ast = createTrapAst();
  const removal = removeTrivialRethrowHandlers(ast);
  t.ok(removal.changed, 'trap handler should be removed from exception table');
  t.equal(removal.removals.length, 1, 'reports one removal');

  const code = ast.classes[0].items[0].method.attributes[0].code;
  t.equal(code.exceptionTable.length, 0, 'exception table is now empty');

  const ops = ast.classes[0].items[0].method.attributes[0].code.codeItems
    .map((item) => item.instruction)
    .filter(Boolean)
    .map((instruction) => (typeof instruction === 'string' ? instruction : instruction.op));
  t.deepEqual(ops, ['goto', 'return'], 'normal control remains and dead athrow is gone');
  t.end();
});

test('removeTrivialRethrowHandlers preserves handlers with normal branch references', (t) => {
  const ast = createTrapAst();
  const code = ast.classes[0].items[0].method.attributes[0].code;
  code.codeItems[0].instruction.arg = 'L1';

  const removal = removeTrivialRethrowHandlers(ast);
  t.notOk(removal.changed, 'normally referenced athrow handler is preserved');
  t.equal(code.exceptionTable.length, 1, 'exception table entry remains');
  t.end();
});

test('removeTrivialRethrowHandlers can keep handler code as a CFR-friendly sentinel', (t) => {
  const ast = createTrapAst();
  const removal = removeTrivialRethrowHandlers(ast, { removeHandlerCode: false });
  t.ok(removal.changed, 'trap handler should be removed from exception table');

  const code = ast.classes[0].items[0].method.attributes[0].code;
  t.equal(code.exceptionTable.length, 0, 'exception table is now empty');

  const ops = code.codeItems
    .map((item) => item.instruction)
    .filter(Boolean)
    .map((instruction) => (typeof instruction === 'string' ? instruction : instruction.op));
  t.deepEqual(ops, ['goto', 'athrow', 'return'], 'handler athrow remains in the instruction stream');
  t.end();
});

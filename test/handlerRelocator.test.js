'use strict';

const test = require('tape');
const { relocateTrivialHandlers } = require('../src/handlerRelocator');

function createTestAst() {
  return {
    classes: [
      {
        className: 'Test',
        items: [
          {
            type: 'method',
            method: {
              name: 'foo',
              descriptor: '()V',
              attributes: [
                {
                  type: 'code',
                  code: {
                    codeItems: [
                      { labelDef: 'L0:', pc: 0, instruction: { op: 'goto', arg: 'L2' } },
                      { labelDef: 'L1:', pc: 1, instruction: 'athrow' },
                      { labelDef: 'L2:', pc: 2, instruction: 'return' },
                    ],
                    exceptionTable: [
                      {
                        start_pc: 0,
                        end_pc: 0,
                        handler_pc: 1,
                        catch_type: 'java/lang/RuntimeException',
                        startLbl: 'L0',
                        endLbl: 'L0',
                        handlerLbl: 'L1',
                      },
                    ],
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

test('relocateTrivialHandlers moves inline handler and removes redundant goto', (t) => {
  const ast = createTestAst();
  const { changed, relocations } = relocateTrivialHandlers(ast);
  t.ok(changed, 'pass should report modifications');
  t.equal(relocations.length, 1, 'exactly one handler relocated');
  const method = ast.classes[0].items[0].method;
  const codeItems = method.attributes[0].code.codeItems;
  t.equal(codeItems.length, 3, 'code item count stays the same');
  t.equal(codeItems[0].labelDef, 'L0:', 'label order preserved');
  t.notOk(codeItems[0].instruction, 'goto instruction removed after relocation');
  t.equal(codeItems[1].labelDef, 'L2:', 'target label now immediately follows');
  t.equal(codeItems[1].instruction, 'return', 'normal instruction remains');
  t.equal(codeItems[2].labelDef, 'L1:', 'handler label moved to end');
  t.equal(codeItems[2].instruction, 'athrow', 'handler instruction preserved');
  t.end();
});

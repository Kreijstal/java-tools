'use strict';

const test = require('tape');
const { runDeadCodePass } = require('../src/deadCodePass');

function createSyntheticMisplacedAst() {
  return {
    classes: [
      {
        className: 'Misplaced',
        items: [
          {
            type: 'method',
            method: {
              name: 'funnel',
              descriptor: '(I)I',
              flags: ['public', 'static'],
              attributes: [
                {
                  type: 'code',
                  code: {
                    stackSize: '2',
                    localsSize: '1',
                    codeItems: [
                      { pc: 0, labelDef: 'L0:', instruction: 'iconst_0' },
                      { pc: 1, labelDef: 'L1:', instruction: { op: 'goto', arg: 'L3' } },
                      { pc: 2, labelDef: 'L2:', instruction: 'athrow' },
                      { pc: 3, labelDef: 'L3:', instruction: 'iconst_1' },
                      { pc: 4, labelDef: 'L4:', instruction: 'ireturn' },
                    ],
                    exceptionTable: [
                      {
                        start_pc: 0,
                        end_pc: 3,
                        handler_pc: 3,
                        catch_type: 'java/lang/Exception',
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

test('dead-code pass emits diagnostics for misplaced catch handlers', (t) => {
  const ast = createSyntheticMisplacedAst();
  const { diagnostics, changed } = runDeadCodePass(ast);
  t.ok(changed, 'optimizer should modify the AST');
  t.equal(diagnostics.length, 1, 'exactly one diagnostic expected');
  t.equal(diagnostics[0].className, 'Misplaced', 'diagnostic class name matches');
  t.equal(diagnostics[0].methodName, 'funnel', 'diagnostic method matches');
  t.end();
});

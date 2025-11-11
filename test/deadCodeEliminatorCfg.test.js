const test = require('tape');
const { convertAstToCfg } = require('../src/ast-to-cfg');
const { eliminateDeadCodeCfg } = require('../src/deadCodeEliminator-cfg');
const { reconstructAstFromCfg } = require('../src/cfg-to-ast');

function buildFakeCatchMethod() {
  return {
    name: 'funnel',
    descriptor: '()V',
    attributes: [
      {
        type: 'code',
        code: {
          stackSize: '2',
          localsSize: '1',
          codeItems: [
            {
              pc: 0,
              labelDef: 'L0:',
              instruction: { op: 'goto', arg: 'L2' },
            },
            {
              pc: 1,
              labelDef: 'L1:',
              instruction: 'athrow',
            },
            {
              pc: 2,
              labelDef: 'L2:',
              instruction: 'return',
            },
          ],
          exceptionTable: [],
          attributes: [],
        },
      },
    ],
  };
}

test('eliminateDeadCodeCfg removes unreachable throw blocks', (t) => {
  t.plan(3);

  const methodAst = buildFakeCatchMethod();
  const cfg = convertAstToCfg(methodAst);
  const { changed, optimizedCfg } = eliminateDeadCodeCfg(cfg);

  t.ok(changed, 'should report changes when pruning unreachable blocks');

  const optimizedMethod = reconstructAstFromCfg(optimizedCfg, methodAst);
  const codeAttr = optimizedMethod.attributes.find((attr) => attr.type === 'code');
  const ops = codeAttr.code.codeItems
    .map((item) => item.instruction)
    .filter(Boolean)
    .map((instr) => (typeof instr === 'string' ? instr : instr.op));

  t.equal(
    ops.filter((op) => op === 'athrow').length,
    0,
    'athrow should be removed when its block becomes unreachable',
  );
  t.deepEqual(ops, ['return'], 'redundant goto should be simplified away');
  t.end();
});

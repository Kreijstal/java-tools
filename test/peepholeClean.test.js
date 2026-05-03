'use strict';

const test = require('tape');
const { runPeepholeClean } = require('../src/peepholeClean');

function astWith(codeItems, exceptionTable = []) {
  return {
    classes: [
      {
        className: 'Peephole',
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
                    codeItems,
                    exceptionTable,
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

function code(ast) {
  return ast.classes[0].items[0].method.attributes[0].code;
}

test('peephole clean removes nops and unused labels', (t) => {
  const ast = astWith([
    { labelDef: 'L0:', instruction: 'nop' },
    { labelDef: 'L1:', instruction: 'return' },
  ]);

  const result = runPeepholeClean(ast);
  t.ok(result.changed);
  t.equal(result.details.nops, 1);
  t.equal(result.details.unusedLabels, 2);
  t.deepEqual(
    code(ast).codeItems.map((item) => item.instruction).filter(Boolean),
    ['return'],
  );
  t.end();
});

test('peephole clean removes single-use goto to following label', (t) => {
  const ast = astWith([
    { labelDef: 'L0:', instruction: { op: 'goto', arg: 'L1' } },
    { labelDef: 'L1:', instruction: 'return' },
  ]);

  const result = runPeepholeClean(ast);
  t.ok(result.changed);
  t.equal(result.details.fallthroughGotos, 1);
  t.deepEqual(
    code(ast).codeItems.map((item) => item.instruction).filter(Boolean),
    ['return'],
  );
  t.end();
});

test('peephole clean keeps handler athrow sentinels by default', (t) => {
  const ast = astWith(
    [
      { pc: 0, labelDef: 'L0:', instruction: { op: 'goto', arg: 'L2' } },
      { pc: 1, labelDef: 'L1:', instruction: 'athrow' },
      { pc: 2, labelDef: 'L2:', instruction: 'return' },
    ],
    [
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
  );

  const result = runPeepholeClean(ast, { removeHandlerCode: false });
  t.ok(result.changed);
  t.equal(code(ast).exceptionTable.length, 0);
  t.deepEqual(
    code(ast).codeItems.map((item) => item.instruction).filter(Boolean).map((insn) => (typeof insn === 'string' ? insn : insn.op)),
    ['goto', 'athrow', 'return'],
  );
  t.end();
});

'use strict';

const test = require('tape');
const { removeDummyStackOps } = require('../src/removeDummyStackOps');

function buildProgram(instructions) {
  return {
    classes: [
      {
        className: 'Sample',
        items: [
          {
            type: 'method',
            method: {
              name: 'noop',
              descriptor: '()V',
              attributes: [
                {
                  type: 'code',
                  code: {
                    stackSize: '1',
                    localsSize: '1',
                    codeItems: instructions,
                    exceptionTable: [],
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

test('removes simple push/pop pair', (t) => {
  const program = buildProgram([
    { pc: 0, labelDef: 'L0:', instruction: 'aconst_null' },
    { pc: 1, instruction: 'pop' },
    { pc: 2, instruction: 'return' },
  ]);
  const result = removeDummyStackOps(program);
  t.ok(result.changed, 'pass should remove the redundant pair');
  t.equal(result.methods.length, 1, 'one method should be reported as changed');
  t.equal(result.methods[0].removedPairs, 1, 'one pair removed');
  const codeItems =
    program.classes[0].items[0].method.attributes[0].code.codeItems;
  t.equal(codeItems.length, 2, 'stack pair removed but label retained');
  t.same(
    codeItems[0],
    { pc: 0, labelDef: 'L0:' },
    'label entry remains without instruction',
  );
  t.equal(codeItems[1].instruction, 'return', 'return remains as final instruction');
  t.end();
});

test('removes long/double producer consumed by pop2', (t) => {
  const program = buildProgram([
    { pc: 0, instruction: 'ldc2_w' },
    { pc: 2, instruction: 'pop2' },
    { pc: 4, instruction: 'return' },
  ]);
  const result = removeDummyStackOps(program);
  t.ok(result.changed, 'ldc2_w/pop2 pair should be pruned');
  const codeItems =
    program.classes[0].items[0].method.attributes[0].code.codeItems;
  t.equal(codeItems.length, 1, 'only return remains');
  t.equal(codeItems[0].instruction, 'return');
  t.end();
});

test('no removal when producer is effectful', (t) => {
  const program = buildProgram([
    {
      pc: 0,
      instruction: {
        op: 'getstatic',
        arg: ['Field', 'Example', ['value', 'I']],
      },
    },
    { pc: 1, instruction: 'pop' },
    { pc: 2, instruction: 'return' },
  ]);
  const result = removeDummyStackOps(program);
  t.notOk(result.changed, 'effectful instructions should stay');
  const codeItems =
    program.classes[0].items[0].method.attributes[0].code.codeItems;
  t.equal(codeItems.length, 3, 'all instructions remain intact');
  t.end();
});

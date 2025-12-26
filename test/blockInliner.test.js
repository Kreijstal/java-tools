'use strict';

const test = require('tape');
const { inlineSinglePredecessorBlocks } = require('../src/blockInliner');

function createAst() {
  return {
    classes: [
      {
        className: 'Foo',
        items: [
          {
            type: 'method',
            method: {
              name: 'bar',
              descriptor: '()V',
              attributes: [
                {
                  type: 'code',
                  code: {
                    codeItems: [
                      { labelDef: 'L0:', pc: 0, instruction: { op: 'goto', arg: 'L2' } },
                      { labelDef: 'L2:', pc: 2, instruction: 'return' },
                      { labelDef: 'L1:', pc: 3, instruction: 'nop' },
                      { labelDef: 'L3:', pc: 4, instruction: 'nop' },
                    ],
                    exceptionTable: [],
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

test('inlineSinglePredecessorBlocks moves unique-target block', (t) => {
  const ast = createAst();
  const { changed, merges } = inlineSinglePredecessorBlocks(ast);
  t.ok(changed, 'pass should report change');
  t.equal(merges.length, 1, 'one block should be inlined');
  const codeItems = ast.classes[0].items[0].method.attributes[0].code.codeItems;
  t.equal(codeItems[0].labelDef, 'L0:', 'original label stays at the goto site');
  t.equal(codeItems[0].instruction, 'return', 'return now inlined');
  t.equal(codeItems[1].labelDef, 'L1:', 'other labels keep their order');
  t.equal(codeItems[1].instruction, 'nop', 'code following remains');
  t.end();
});

test('block inliner preserves labels that other branches reference', (t) => {
  const ast = {
    classes: [
      {
        className: 'Foo',
        items: [
          {
            type: 'method',
            method: {
              name: 'withBranches',
              descriptor: '()V',
              attributes: [
                {
                  type: 'code',
                  code: {
                    codeItems: [
                      { labelDef: 'L0:', pc: 0, instruction: { op: 'ifeq', arg: 'L1' } },
                      { labelDef: 'L1:', pc: 2, instruction: { op: 'goto', arg: 'L2' } },
                      { labelDef: 'L2:', pc: 4, instruction: 'return' },
                    ],
                    exceptionTable: [],
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const { changed } = inlineSinglePredecessorBlocks(ast);
  t.ok(changed, 'pass should inline the unique target');
  const codeItems = ast.classes[0].items[0].method.attributes[0].code.codeItems;
  t.equal(codeItems[1].labelDef, 'L1:', 'original label L1 is preserved');
  t.equal(codeItems[1].instruction, 'return', 'return instruction replaces goto');
  t.end();
});

test('block inliner skips labels with fallthrough predecessors', (t) => {
  const ast = {
    classes: [
      {
        className: 'Foo',
        items: [
          {
            type: 'method',
            method: {
              name: 'baz',
              descriptor: '()V',
              attributes: [
                {
                  type: 'code',
                  code: {
                    codeItems: [
                      { labelDef: 'L0:', pc: 0, instruction: 'nop' },
                      { labelDef: 'L1:', pc: 1, instruction: { op: 'goto', arg: 'L3' } },
                      { labelDef: 'L2:', pc: 2, instruction: 'nop' },
                      { labelDef: 'L3:', pc: 3, instruction: 'return' },
                    ],
                    exceptionTable: [],
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const { changed } = inlineSinglePredecessorBlocks(ast);
  t.notOk(changed, 'no changes when label can be reached via fallthrough');
  t.end();
});

test('block inliner ignores unrelated later exception coverage', (t) => {
  const ast = {
    classes: [
      {
        className: 'Foo',
        items: [
          {
            type: 'method',
            method: {
              name: 'baz',
              descriptor: '()V',
              attributes: [
                {
                  type: 'code',
                  code: {
                    codeItems: [
                      { labelDef: 'L0:', pc: 0, instruction: { op: 'goto', arg: 'L2' } },
                      { labelDef: 'L1:', pc: 1, instruction: 'return' },
                      { labelDef: 'L2:', pc: 2, instruction: 'return' },
                      { labelDef: 'L3:', pc: 3, instruction: 'nop' },
                    ],
                    exceptionTable: [
                      {
                        start_pc: 3,
                        end_pc: 4,
                        handler_pc: 4,
                        catch_type: 'java/lang/Exception',
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
  const { changed, merges } = inlineSinglePredecessorBlocks(ast);
  t.ok(changed, 'pass should still inline block');
  t.equal(merges.length, 1, 'single block merged');
  const codeItems = ast.classes[0].items[0].method.attributes[0].code.codeItems;
  t.equal(codeItems[0].instruction, 'return', 'return should move to goto');
  t.end();
});

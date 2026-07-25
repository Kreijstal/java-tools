'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runMultiEntryLoopNormalizer } = require('../src/passes/multiEntryLoopNormalizer');

function astWith(codeItems) {
  return {
    classes: [
      {
        className: 'Target',
        items: [
          {
            type: 'method',
            method: {
              name: 'm',
              descriptor: '()V',
              attributes: [
                {
                  type: 'code',
                  code: {
                    codeItems,
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

function multiEntryLoopItems() {
  return [
    { labelDef: 'L0:', instruction: { op: 'goto', arg: 'Lloop' } },
    { labelDef: 'Lloop:', instruction: { op: 'iinc', arg: '1 -1' } },
    { instruction: { op: 'goto', arg: 'Lbody' } },
    { labelDef: 'Lbody:', instruction: 'return' },
    { labelDef: 'Lback:', instruction: { op: 'goto', arg: 'Lloop' } },
  ];
}

test('multi-entry loop normalizer can skip configured methods', () => {
  const ast = astWith(multiEntryLoopItems());

  const result = runMultiEntryLoopNormalizer(ast, {
    skipMethods: [
      { owner: 'Target', name: 'm', descriptor: '()V' },
    ],
  });

  assert.equal(result.changed, false);
  assert.equal(result.splits, 0);
  assert.equal(
    ast.classes[0].items[0].method.attributes[0].code.codeItems
      .some((item) => item.labelDef === '_meln_1_entry:'),
    false,
  );
});

test('multi-entry loop normalizer still rewrites unskipped methods', () => {
  const ast = astWith(multiEntryLoopItems());

  const result = runMultiEntryLoopNormalizer(ast);

  assert.equal(result.changed, true);
  assert.equal(result.splits, 1);
  assert.equal(
    ast.classes[0].items[0].method.attributes[0].code.codeItems
      .some((item) => item.labelDef && item.labelDef.includes('_meln_')),
    true,
  );
});

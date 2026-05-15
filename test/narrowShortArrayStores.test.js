'use strict';

const test = require('tape');
const { narrowCodeItems, runNarrowShortArrayStores } = require('../src/passes/narrowShortArrayStores');

test('narrowCodeItems inserts short narrowing before local sastore', (t) => {
  const codeItems = [
    { instruction: 'aload_1' },
    { instruction: 'iload_2' },
    { instruction: { op: 'iload', arg: '5' } },
    { instruction: 'sastore' },
  ];

  t.equal(narrowCodeItems(codeItems, { descriptor: '([S)V' }), 1);
  t.equal(codeItems[3].instruction, 'i2s');
  t.end();
});

test('narrowCodeItems avoids unknown sastore arrays', (t) => {
  const codeItems = [
    { instruction: 'aload_0' },
    { instruction: 'iload_1' },
    { instruction: { op: 'iload', arg: '5' } },
    { instruction: 'sastore' },
  ];

  t.equal(narrowCodeItems(codeItems, { flags: ['static'], descriptor: '()V' }), 0);
  t.equal(codeItems.length, 4);
  t.end();
});

test('runNarrowShortArrayStores rewrites method code items', (t) => {
  const ast = {
    classes: [{
      items: [{
        type: 'method',
        method: {
          flags: ['static'],
          descriptor: '([S)V',
          attributes: [{
            type: 'code',
            code: {
              codeItems: [
                { instruction: 'aload_0' },
                { instruction: 'iload_1' },
                { instruction: { op: 'iload', arg: '2' } },
                { instruction: 'sastore' },
              ],
            },
          }],
        },
      }],
    }],
  };

  const result = runNarrowShortArrayStores(ast);
  t.equal(result.rewrites, 1);
  t.equal(ast.classes[0].items[0].method.attributes[0].code.codeItems[3].instruction, 'i2s');
  t.end();
});

'use strict';

const test = require('tape');
const { narrowCodeItems, runNarrowByteArrayStores } = require('../src/narrowByteArrayStores');

test('narrowCodeItems inserts byte narrowing before non-boolean constant bastore', (t) => {
  const codeItems = [
    { instruction: { op: 'aload', arg: '4' } },
    { instruction: { op: 'iload', arg: '7' } },
    { instruction: { op: 'bipush', arg: '-97' } },
    { instruction: 'bastore' },
  ];

  t.equal(narrowCodeItems(codeItems, { flags: ['static'], descriptor: '(IIII[B)V' }), 1, 'rewrites one byte array store');
  t.deepEqual(codeItems.map((item) => item.instruction), [
    { op: 'aload', arg: '4' },
    { op: 'iload', arg: '7' },
    { op: 'bipush', arg: '-97' },
    'i2b',
    'bastore',
  ]);
  t.end();
});

test('narrowCodeItems inserts byte narrowing before local bastore', (t) => {
  const codeItems = [
    { instruction: 'aload_1' },
    { instruction: 'iload_1' },
    { instruction: { op: 'iload', arg: '5' } },
    { instruction: 'bastore' },
  ];

  t.equal(narrowCodeItems(codeItems, { descriptor: '([B)V' }), 1, 'rewrites one local byte array store');
  t.equal(codeItems[3].instruction, 'i2b');
  t.end();
});

test('narrowCodeItems avoids boolean-looking bastore values', (t) => {
  const codeItems = [
    { instruction: 'aload_0' },
    { instruction: 'iload_1' },
    { instruction: 'iconst_1' },
    { instruction: 'bastore' },
  ];

  t.equal(narrowCodeItems(codeItems, { descriptor: '([Z)V' }), 0, 'does not rewrite boolean-looking store');
  t.equal(codeItems.length, 4, 'items are unchanged');
  t.end();
});

test('narrowCodeItems avoids unknown bastore arrays', (t) => {
  const codeItems = [
    { instruction: 'aload_0' },
    { instruction: 'iload_1' },
    { instruction: { op: 'bipush', arg: '-97' } },
    { instruction: 'bastore' },
  ];

  t.equal(narrowCodeItems(codeItems, { flags: ['static'], descriptor: '()V' }), 0, 'does not rewrite unknown array type');
  t.equal(codeItems.length, 4, 'items are unchanged');
  t.end();
});

test('narrowCodeItems recognizes byte array rows from byte array arrays', (t) => {
  const codeItems = [
    { instruction: { op: 'sipush', arg: '256' } },
    { instruction: { op: 'anewarray', arg: '[B' } },
    { instruction: { op: 'astore', arg: '5' } },
    { instruction: { op: 'aload', arg: '5' } },
    { instruction: { op: 'iload', arg: '6' } },
    { instruction: 'aaload' },
    { instruction: { op: 'iload', arg: '8' } },
    { instruction: { op: 'iload', arg: '7' } },
    { instruction: 'bastore' },
  ];

  t.equal(narrowCodeItems(codeItems, { flags: ['static'], descriptor: '()V' }), 1, 'rewrites one byte array row store');
  t.equal(codeItems[8].instruction, 'i2b');
  t.end();
});

test('narrowCodeItems recognizes byte array local through complex index expression', (t) => {
  const codeItems = [
    { instruction: { op: 'newarray', arg: 'byte' } },
    { instruction: { op: 'astore', arg: '8' } },
    { instruction: { op: 'aload', arg: '8' } },
    { instruction: { op: 'iload', arg: '12' } },
    { instruction: { op: 'iload', arg: '7' } },
    { instruction: { op: 'getfield', arg: ['Field', 'pi', ['lc_b', 'I']] } },
    { instruction: 'iconst_3' },
    { instruction: 'imul' },
    { instruction: 'iadd' },
    { instruction: 'iconst_2' },
    { instruction: 'iadd' },
    { instruction: { op: 'iload', arg: '11' } },
    { instruction: 'bastore' },
  ];

  t.equal(narrowCodeItems(codeItems, { flags: ['static'], descriptor: '()V' }), 1);
  t.equal(codeItems[12].instruction, 'i2b');
  t.end();
});

test('runNarrowByteArrayStores rewrites method code items', (t) => {
  const ast = {
    classes: [
      {
        items: [
          {
            type: 'method',
            method: {
              flags: ['static'],
              descriptor: '([B)V',
              attributes: [
                {
                  type: 'code',
                  code: {
                    codeItems: [
                      { instruction: 'aload_0' },
                      { instruction: 'iload_1' },
                      { instruction: { op: 'bipush', arg: '127' } },
                      { instruction: 'bastore' },
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

  const result = runNarrowByteArrayStores(ast);
  t.equal(result.rewrites, 1, 'rewrites one method pattern');
  t.equal(ast.classes[0].items[0].method.attributes[0].code.codeItems[3].instruction, 'i2b');
  t.end();
});

'use strict';

const test = require('tape');
const { narrowCodeItems, runNarrowCharArrayStores } = require('../src/narrowCharArrayStores');

test('narrowCodeItems inserts char narrowing before castore when incrementing same local', (t) => {
  const codeItems = [
    { instruction: { op: 'aload', arg: '9' } },
    { instruction: { op: 'iload', arg: '12' } },
    { instruction: { op: 'iload', arg: '14' } },
    { instruction: { op: 'iload', arg: '13' } },
    { instruction: { op: 'iload', arg: '13' } },
    { instruction: 'iconst_1' },
    { instruction: 'iadd' },
    { instruction: 'i2c' },
    { instruction: { op: 'istore', arg: '13' } },
    { instruction: 'castore' },
  ];

  t.equal(narrowCodeItems(codeItems), 1, 'rewrites one char array store');
  t.deepEqual(
    codeItems.map((item) => item.instruction),
    [
      { op: 'aload', arg: '9' },
      { op: 'iload', arg: '12' },
      { op: 'iload', arg: '14' },
      { op: 'iload', arg: '13' },
      { op: 'iload', arg: '13' },
      'iconst_1',
      'iadd',
      'i2c',
      { op: 'istore', arg: '13' },
      'i2c',
      'castore',
    ],
  );
  t.end();
});

test('narrowCodeItems ignores stores to a different local', (t) => {
  const codeItems = [
    { instruction: { op: 'iload', arg: '13' } },
    { instruction: { op: 'iload', arg: '13' } },
    { instruction: 'iconst_1' },
    { instruction: 'iadd' },
    { instruction: 'i2c' },
    { instruction: { op: 'istore', arg: '14' } },
    { instruction: 'castore' },
  ];

  t.equal(narrowCodeItems(codeItems), 0, 'does not rewrite unrelated locals');
  t.equal(codeItems.length, 7, 'items are unchanged');
  t.end();
});

test('narrowCodeItems inserts char narrowing for char-derived local castore', (t) => {
  const codeItems = [
    { instruction: { op: 'aload', arg: '0' } },
    { instruction: { op: 'iload', arg: '4' } },
    { instruction: { op: 'invokeinterface', arg: ['InterfaceMethod', 'java/lang/CharSequence', ['charAt', '(I)C']] } },
    { instruction: { op: 'istore', arg: '5' } },
    { instruction: { op: 'aload', arg: '3' } },
    { instruction: { op: 'iload', arg: '4' } },
    { instruction: { op: 'iload', arg: '5' } },
    { instruction: 'castore' },
  ];

  t.equal(narrowCodeItems(codeItems), 1, 'rewrites one char-derived local store');
  t.deepEqual(
    codeItems.map((item) => item.instruction),
    [
      { op: 'aload', arg: '0' },
      { op: 'iload', arg: '4' },
      { op: 'invokeinterface', arg: ['InterfaceMethod', 'java/lang/CharSequence', ['charAt', '(I)C']] },
      { op: 'istore', arg: '5' },
      { op: 'aload', arg: '3' },
      { op: 'iload', arg: '4' },
      { op: 'iload', arg: '5' },
      'i2c',
      'castore',
    ],
  );
  t.end();
});

test('runNarrowCharArrayStores rewrites method code items', (t) => {
  const ast = {
    classes: [
      {
        items: [
          {
            type: 'method',
            method: {
              attributes: [
                {
                  type: 'code',
                  code: {
                    codeItems: [
                      { instruction: 'iload_2' },
                      { instruction: 'iload_2' },
                      { instruction: 'iconst_1' },
                      { instruction: 'iadd' },
                      { instruction: 'i2c' },
                      { instruction: 'istore_2' },
                      { instruction: 'castore' },
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

  const result = runNarrowCharArrayStores(ast);
  t.equal(result.rewrites, 1, 'rewrites one method pattern');
  t.equal(ast.classes[0].items[0].method.attributes[0].code.codeItems[6].instruction, 'i2c');
  t.end();
});

'use strict';

const test = require('tape');
const { castCodeItems, checkcastTarget, runCastObjectFieldStores } = require('../src/castObjectFieldStores');

test('checkcastTarget returns class names for reference descriptors', (t) => {
  t.equal(checkcastTarget('Ljava/lang/String;'), 'java/lang/String');
  t.equal(checkcastTarget('[Lck;'), '[Lck;');
  t.equal(checkcastTarget('[B'), '[B');
  t.equal(checkcastTarget('I'), null);
  t.end();
});

test('castCodeItems inserts checkcast before putstatic from a constructed local', (t) => {
  const codeItems = [
    { instruction: { op: 'new', arg: 'ck' } },
    { instruction: 'dup' },
    { instruction: { op: 'invokespecial', arg: ['Method', 'ck', ['<init>', '()V']] } },
    { instruction: { op: 'astore', arg: '5' } },
    { instruction: { op: 'aload', arg: '5' } },
    { instruction: { op: 'putstatic', arg: ['Field', 'ge', ['ge_h', 'Lck;']] } },
  ];

  t.equal(castCodeItems(codeItems), 1, 'rewrites one putstatic');
  t.deepEqual(
    codeItems.map((item) => item.instruction),
    [
      { op: 'new', arg: 'ck' },
      'dup',
      { op: 'invokespecial', arg: ['Method', 'ck', ['<init>', '()V']] },
      { op: 'astore', arg: '5' },
      { op: 'aload', arg: '5' },
      { op: 'checkcast', arg: 'ck' },
      { op: 'putstatic', arg: ['Field', 'ge', ['ge_h', 'Lck;']] },
    ],
  );
  t.end();
});

test('castCodeItems inserts checkcast before putfield from a constructed local', (t) => {
  const codeItems = [
    { instruction: { op: 'new', arg: 'ck' } },
    { instruction: 'dup' },
    { instruction: { op: 'invokespecial', arg: ['Method', 'ck', ['<init>', '()V']] } },
    { instruction: 'astore_1' },
    { instruction: 'aload_0' },
    { instruction: 'aload_1' },
    { instruction: { op: 'putfield', arg: ['Field', 'Owner', ['value', 'Lck;']] } },
  ];

  t.equal(castCodeItems(codeItems), 1, 'rewrites one putfield');
  t.equal(codeItems[6].instruction.op, 'checkcast');
  t.equal(codeItems[6].instruction.arg, 'ck');
  t.end();
});

test('castCodeItems ignores primitive fields, already-cast values, and method-return locals', (t) => {
  const codeItems = [
    { instruction: { op: 'invokestatic', arg: ['Method', 'sf', ['c', '(I)Ljava/lang/String;']] } },
    { instruction: 'astore_2' },
    { instruction: 'aload_2' },
    { instruction: { op: 'putstatic', arg: ['Field', 'sl', ['sl_g', 'Ljava/lang/String;']] } },
    { instruction: 'aload_0' },
    { instruction: 'aload_1' },
    { instruction: { op: 'checkcast', arg: 'ck' } },
    { instruction: { op: 'putfield', arg: ['Field', 'Owner', ['value', 'Lck;']] } },
    { instruction: 'aload_0' },
    { instruction: 'iload_1' },
    { instruction: { op: 'putfield', arg: ['Field', 'Owner', ['n', 'I']] } },
  ];

  t.equal(castCodeItems(codeItems), 0, 'does not rewrite unnecessary casts');
  t.equal(codeItems.length, 11, 'items are unchanged');
  t.end();
});

test('runCastObjectFieldStores rewrites method code items', (t) => {
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
                      { instruction: { op: 'new', arg: 'ck' } },
                      { instruction: 'dup' },
                      { instruction: { op: 'invokespecial', arg: ['Method', 'ck', ['<init>', '()V']] } },
                      { instruction: 'astore_1' },
                      { instruction: 'aload_0' },
                      { instruction: 'aload_1' },
                      { instruction: { op: 'putfield', arg: ['Field', 'Owner', ['value', 'Lck;']] } },
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

  const result = runCastObjectFieldStores(ast);
  t.equal(result.rewrites, 1, 'rewrites one method pattern');
  t.deepEqual(ast.classes[0].items[0].method.attributes[0].code.codeItems[6].instruction, { op: 'checkcast', arg: 'ck' });
  t.end();
});

'use strict';

const test = require('tape');
const { rewriteCode, runNormalizeDupStoreLoad } = require('../src/passes/normalizeDupStoreLoad');

test('normalizeDupStoreLoad replaces duplicated float store with store and reload', (t) => {
  const code = {
    codeItems: [
      { instruction: { op: 'fload', arg: '2' } },
      { labelDef: 'L1:', instruction: 'dup' },
      { labelDef: 'L2:', instruction: { op: 'fstore', arg: '2' } },
      { instruction: 'fconst_0' },
      { instruction: 'fcmpl' },
      { instruction: { op: 'iflt', arg: 'Done' } },
      { labelDef: 'Done:', instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(rewriteCode(code), 1);
  t.deepEqual(code.codeItems.map((item) => item.instruction), [
    { op: 'fload', arg: '2' },
    { op: 'fstore', arg: '2' },
    'fload_2',
    'fconst_0',
    'fcmpl',
    { op: 'iflt', arg: 'Done' },
    'return',
  ]);
  t.equal(code.codeItems[1].labelDef, 'L1:');
  t.notOk(code.codeItems[2].labelDef);
  t.end();
});

test('runNormalizeDupStoreLoad rewrites method code items', (t) => {
  const ast = {
    classes: [{
      items: [{
        type: 'method',
        method: {
          attributes: [{
            type: 'code',
            code: {
              codeItems: [
                { instruction: 'dup' },
                { instruction: 'fstore_1' },
                { instruction: 'fconst_0' },
                { instruction: 'fcmpl' },
              ],
              exceptionTable: [],
            },
          }],
        },
      }],
    }],
  };

  const result = runNormalizeDupStoreLoad(ast);
  t.equal(result.rewrites, 1);
  t.equal(ast.classes[0].items[0].method.attributes[0].code.codeItems[1].instruction, 'fload_1');
  t.end();
});

test('normalizeDupStoreLoad does not rewrite int dup stores', (t) => {
  const code = {
    codeItems: [
      { instruction: 'dup' },
      { instruction: 'istore_1' },
      { instruction: 'iconst_0' },
      { instruction: 'if_icmpeq' },
    ],
    exceptionTable: [],
  };

  t.equal(rewriteCode(code), 0);
  t.deepEqual(code.codeItems.map((item) => item.instruction), [
    'dup',
    'istore_1',
    'iconst_0',
    'if_icmpeq',
  ]);
  t.end();
});

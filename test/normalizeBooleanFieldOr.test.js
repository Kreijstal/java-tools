'use strict';

const test = require('tape');
const { rewriteCode, runNormalizeBooleanFieldOr } = require('../src/passes/normalizeBooleanFieldOr');

const field = ['Field', 'Demo', ['flag', 'Z']];

test('normalizeBooleanFieldOr rewrites boolean field or int flag', (t) => {
  const code = {
    codeItems: [
      { labelDef: 'Start:', instruction: 'aload_0' },
      { instruction: 'dup' },
      { instruction: { op: 'getfield', arg: field } },
      { instruction: { op: 'iload', arg: '5' } },
      { instruction: 'ior' },
      { instruction: { op: 'putfield', arg: field } },
      { instruction: 'return' },
    ],
  };

  t.equal(rewriteCode(code), 1);
  t.deepEqual(code.codeItems.map((item) => item.instruction), [
    { op: 'iload', arg: '5' },
    { op: 'ifeq', arg: 'L_bool_or_done' },
    'aload_0',
    'iconst_1',
    { op: 'putfield', arg: field },
    'nop',
    'return',
  ]);
  t.equal(code.codeItems[0].labelDef, 'Start:');
  t.equal(code.codeItems[5].labelDef, 'L_bool_or_done:');
  t.end();
});

test('runNormalizeBooleanFieldOr rewrites method code items', (t) => {
  const ast = {
    classes: [{
      items: [{
        type: 'method',
        method: {
          attributes: [{
            type: 'code',
            code: {
              codeItems: [
                { instruction: { op: 'aload', arg: '0' } },
                { instruction: 'dup' },
                { instruction: { op: 'getfield', arg: field } },
                { instruction: 'iload_1' },
                { instruction: 'ior' },
                { instruction: { op: 'putfield', arg: field } },
              ],
            },
          }],
        },
      }],
    }],
  };

  const result = runNormalizeBooleanFieldOr(ast);
  t.equal(result.rewrites, 1);
  t.equal(ast.classes[0].items[0].method.attributes[0].code.codeItems[1].instruction.op, 'ifeq');
  t.end();
});

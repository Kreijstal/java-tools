'use strict';

const test = require('tape');
const { runIntizeBooleanParameters } = require('../src/passes/intizeBooleanParameters');

function astWith(methods) {
  return {
    classes: [{
      className: 'Demo',
      items: methods.map((method) => ({ type: 'method', method })),
    }],
  };
}

function method(name, descriptor, flags, codeItems) {
  return {
    name,
    descriptor,
    flags,
    attributes: [{ type: 'code', code: { codeItems, exceptionTable: [], attributes: [] } }],
  };
}

test('intize-boolean-parameters: retargets private boolean parameter used as int', (t) => {
  const callee = method('b', '(IZI)V', ['private', 'final'], [
    { instruction: 'iload_2' },
    { instruction: { op: 'istore', arg: '4' } },
    { instruction: 'iload_2' },
    { instruction: { op: 'istore', arg: '5' } },
    { instruction: { op: 'getstatic', arg: ['Field', 'Flags', ['value', 'I']] } },
    { instruction: { op: 'iload', arg: '5' } },
    { instruction: 'bipush' },
    { instruction: { op: 'iload', arg: '4' } },
    { instruction: { op: 'invokestatic', arg: ['Method', 'Helper', ['useMixed', '(IZBI)V']] } },
    { instruction: 'iload_2' },
    { instruction: { op: 'invokestatic', arg: ['Method', 'Helper', ['useBoolean', '(Z)V']] } },
    { instruction: 'return' },
  ]);
  const caller = method('a', '()V', ['public'], [
    { instruction: 'aload_0' },
    { instruction: 'iconst_1' },
    { instruction: 'iconst_0' },
    { instruction: 'iconst_2' },
    { instruction: { op: 'invokespecial', arg: ['Method', 'Demo', ['b', '(IZI)V']] } },
    { instruction: 'return' },
  ]);
  const ast = astWith([callee, caller]);

  const result = runIntizeBooleanParameters(ast);

  t.deepEqual(result, { changed: true, rewrites: 3 });
  t.equal(callee.descriptor, '(III)V');
  t.equal(caller.attributes[0].code.codeItems[4].instruction.arg[2][1], '(III)V');
  t.ok(callee.attributes[0].code.codeItems.some((item) => item.instruction && item.instruction.op === 'ifeq'), 'booleanizes copied parameter store');
  t.end();
});

test('intize-boolean-parameters: keeps pure boolean private parameters', (t) => {
  const callee = method('b', '(IZI)V', ['private'], [
    { instruction: 'iload_2' },
    { instruction: { op: 'ifeq', arg: 'Done' } },
    { labelDef: 'Done:', instruction: 'return' },
  ]);
  const ast = astWith([callee]);

  const result = runIntizeBooleanParameters(ast);

  t.deepEqual(result, { changed: false, rewrites: 0 });
  t.equal(callee.descriptor, '(IZI)V');
  t.end();
});

test('intize-boolean-parameters: skips non-private methods by default', (t) => {
  const callee = method('b', '(IZI)V', ['public'], [
    { instruction: 'iload_2' },
    { instruction: { op: 'istore', arg: '4' } },
    { instruction: 'return' },
  ]);
  const ast = astWith([callee]);

  const result = runIntizeBooleanParameters(ast);

  t.deepEqual(result, { changed: false, rewrites: 0 });
  t.equal(callee.descriptor, '(IZI)V');
  t.end();
});

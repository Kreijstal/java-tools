'use strict';

const test = require('tape');
const { runConstructorPreSuperCleanup } = require('../src/passes/constructorPreSuperCleanup');

function astWith(codeItems, exceptionTable = []) {
  return {
    classes: [{
      className: 'Child',
      superClassName: 'Parent',
      items: [{
        type: 'method',
        method: {
          name: '<init>',
          descriptor: '()V',
          attributes: [{ type: 'code', code: { codeItems, exceptionTable } }],
        },
      }],
    }],
  };
}

test('deletes unused boolean snapshot before super', (t) => {
  const ast = astWith([
    { instruction: { op: 'getstatic', arg: ['Field', 'client', ['A', 'Z']] } },
    { instruction: { op: 'istore', arg: '10' } },
    { instruction: 'aload_0' },
    { instruction: { op: 'invokespecial', arg: ['Method', 'Parent', ['<init>', '()V']] } },
    { instruction: 'return' },
  ]);

  const result = runConstructorPreSuperCleanup(ast);
  t.equal(result.deletedSnapshots, 1);
  t.deepEqual(ast.classes[0].items[0].method.attributes[0].code.codeItems.map((i) => i.instruction), [
    'aload_0',
    { op: 'invokespecial', arg: ['Method', 'Parent', ['<init>', '()V']] },
    'return',
  ]);
  t.end();
});

test('preserves labels when deleting snapshot instructions', (t) => {
  const ast = astWith([
    { labelDef: 'L0:', instruction: { op: 'getstatic', arg: ['Field', 'client', ['A', 'Z']] } },
    { labelDef: 'L1:', instruction: 'istore_3' },
    { instruction: 'aload_0' },
    { instruction: { op: 'invokespecial', arg: ['Method', 'Parent', ['<init>', '()V']] } },
    { instruction: 'return' },
  ]);

  const result = runConstructorPreSuperCleanup(ast);
  const items = ast.classes[0].items[0].method.attributes[0].code.codeItems;
  t.equal(result.deletedSnapshots, 1);
  t.equal(items[0].labelDef, 'L0:');
  t.equal(items[0].instruction, undefined);
  t.equal(items[1].labelDef, 'L1:');
  t.equal(items[1].instruction, undefined);
  t.end();
});

test('skips used snapshot local', (t) => {
  const ast = astWith([
    { instruction: { op: 'getstatic', arg: ['Field', 'client', ['A', 'Z']] } },
    { instruction: { op: 'istore', arg: '10' } },
    { instruction: 'aload_0' },
    { instruction: { op: 'invokespecial', arg: ['Method', 'Parent', ['<init>', '()V']] } },
    { instruction: { op: 'iload', arg: '10' } },
    { instruction: 'pop' },
    { instruction: 'return' },
  ]);

  const result = runConstructorPreSuperCleanup(ast);
  t.equal(result.deletedSnapshots, 0);
  t.equal(ast.classes[0].items[0].method.attributes[0].code.codeItems.length, 7);
  t.end();
});

test('deletes unused int snapshot before super', (t) => {
  const ast = astWith([
    { instruction: { op: 'getstatic', arg: ['Field', 'client', ['N', 'I']] } },
    { instruction: { op: 'istore', arg: '10' } },
    { instruction: 'aload_0' },
    { instruction: { op: 'invokespecial', arg: ['Method', 'Parent', ['<init>', '()V']] } },
  ]);

  t.equal(runConstructorPreSuperCleanup(ast).deletedSnapshots, 1);
  t.end();
});

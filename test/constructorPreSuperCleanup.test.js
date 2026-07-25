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

test('inlines adjacent reference temp before this constructor delegation', (t) => {
  const ast = {
    classes: [{
      className: 'Child',
      superClassName: 'Parent',
      items: [{
        type: 'method',
        method: {
          name: '<init>',
          descriptor: '(Ljava/lang/String;)V',
          attributes: [{
            type: 'code',
            code: {
              codeItems: [
                { instruction: 'aload_0' },
                { instruction: 'aload_1' },
                { instruction: { op: 'checkcast', arg: 'java/lang/CharSequence' } },
                { instruction: { op: 'astore', arg: '8' } },
                { instruction: { op: 'aload', arg: '8' } },
                { instruction: 'iconst_1' },
                { instruction: { op: 'invokestatic', arg: ['Method', 'qua', ['a', '(Ljava/lang/CharSequence;Z)J']] } },
                { instruction: { op: 'invokespecial', arg: ['Method', 'Child', ['<init>', '(J)V']] } },
                { instruction: 'return' },
              ],
              exceptionTable: [],
            },
          }],
        },
      }],
    }],
  };

  const result = runConstructorPreSuperCleanup(ast);
  const items = ast.classes[0].items[0].method.attributes[0].code.codeItems;
  t.equal(result.inlinedTemps, 1);
  t.deepEqual(items.map((item) => item.instruction), [
    'aload_0',
    'aload_1',
    { op: 'checkcast', arg: 'java/lang/CharSequence' },
    'iconst_1',
    { op: 'invokestatic', arg: ['Method', 'qua', ['a', '(Ljava/lang/CharSequence;Z)J']] },
    { op: 'invokespecial', arg: ['Method', 'Child', ['<init>', '(J)V']] },
    'return',
  ]);
  t.end();
});

test('keeps labelled reference temp before constructor delegation', (t) => {
  const ast = {
    classes: [{
      className: 'Child',
      superClassName: 'Parent',
      items: [{
        type: 'method',
        method: {
          name: '<init>',
          descriptor: '(Ljava/lang/String;)V',
          attributes: [{
            type: 'code',
            code: {
              codeItems: [
                { instruction: 'aload_0' },
                { instruction: 'aload_1' },
                { labelDef: 'Lstore:', instruction: { op: 'astore', arg: '8' } },
                { instruction: { op: 'goto', arg: 'Lstore' } },
                { instruction: { op: 'aload', arg: '8' } },
                { instruction: { op: 'invokespecial', arg: ['Method', 'Child', ['<init>', '(Ljava/lang/String;)V']] } },
                { instruction: 'return' },
              ],
              exceptionTable: [],
            },
          }],
        },
      }],
    }],
  };

  const result = runConstructorPreSuperCleanup(ast);
  t.equal(result.inlinedTemps, 0);
  t.end();
});

'use strict';

const test = require('tape');
const { runAddDefaultConstructorsForImplicitSupers } = require('../src/passes/addDefaultConstructorsForImplicitSupers');

function cls(className, superClassName, items = [], flags = ['super']) {
  return { className, superClassName, flags, items };
}

function method(name, descriptor = '()V') {
  return {
    type: 'method',
    method: { flags: [], accessFlags: 0, name, descriptor, attributes: [] },
  };
}

test('add-default-constructors: adds no-arg constructor to constructorless implicit super', (t) => {
  const ast = {
    classes: [
      cls('Base', 'java/lang/Object', [method('helper')]),
      cls('Child', 'Base', [method('use')]),
    ],
  };

  const result = runAddDefaultConstructorsForImplicitSupers(ast);
  const ctor = ast.classes[0].items.find((item) => item.method && item.method.name === '<init>');

  t.deepEqual(result, { changed: true, added: 1 });
  t.ok(ctor, 'base constructor added');
  t.equal(ctor.method.descriptor, '()V');
  t.deepEqual(ctor.method.attributes[0].code.codeItems.map((item) => item.instruction), [
    'aload_0',
    { op: 'invokespecial', arg: ['Method', 'java/lang/Object', ['<init>', '()V']] },
    'return',
  ]);
  t.notOk(ast.classes[1].items.some((item) => item.method && item.method.name === '<init>'), 'child is left implicit');
  t.end();
});

test('add-default-constructors: walks constructorless super chains', (t) => {
  const ast = {
    classes: [
      cls('Base', 'java/lang/Object', [method('base')]),
      cls('Mid', 'Base', [method('mid')]),
      cls('Leaf', 'Mid', [method('leaf')]),
    ],
  };

  const result = runAddDefaultConstructorsForImplicitSupers(ast);

  t.deepEqual(result, { changed: true, added: 2 });
  t.ok(ast.classes[0].items.some((item) => item.method && item.method.name === '<init>'), 'base constructor added');
  t.ok(ast.classes[1].items.some((item) => item.method && item.method.name === '<init>'), 'mid constructor added');
  t.notOk(ast.classes[2].items.some((item) => item.method && item.method.name === '<init>'), 'leaf remains implicit');
  t.end();
});

test('add-default-constructors: skips existing constructors and interfaces', (t) => {
  const ast = {
    classes: [
      cls('HasCtor', 'java/lang/Object', [method('<init>')]),
      cls('Child', 'HasCtor', [method('use')]),
      cls('Iface', 'java/lang/Object', [], ['interface', 'abstract']),
      cls('Impl', 'Iface', [method('impl')]),
    ],
  };

  const result = runAddDefaultConstructorsForImplicitSupers(ast);

  t.deepEqual(result, { changed: false, added: 0 });
  t.equal(ast.classes[0].items.filter((item) => item.method && item.method.name === '<init>').length, 1);
  t.end();
});

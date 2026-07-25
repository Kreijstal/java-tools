'use strict';

const test = require('tape');
const { ClassHierarchy } = require('../src/analysis/closedWorld/classHierarchy');

function cls(name, superClassName, { flags = [], interfaces = [], methods = [] } = {}) {
  return {
    ast: {
      classes: [{
        className: name,
        superClassName,
        interfaces,
        flags,
        items: methods.map(([mName, descriptor, mFlags]) => ({
          type: 'method',
          method: { name: mName, descriptor, flags: mFlags || [], attributes: [] },
        })),
      }],
    },
  };
}

function world(classes) {
  return { classes, classEpoch: 1 };
}

test('resolveDispatch enumerates the concrete cone and dedups inherited impls', (t) => {
  const jvm = world({
    'java/lang/Object': cls('java/lang/Object', null),
    Base: cls('Base', 'java/lang/Object', {
      flags: ['abstract'],
      methods: [['run', '()I', []], ['abs', '()I', ['abstract']]],
    }),
    A: cls('A', 'Base', { methods: [['abs', '()I', []]] }),
    B: cls('B', 'Base', { methods: [['abs', '()I', []], ['run', '()I', []]] }),
    C: cls('C', 'A', {}),
  });
  const h = new ClassHierarchy(jvm);

  const run = h.resolveDispatch('Base', 'run', '()I');
  t.ok(run, 'run resolves');
  t.equal(run.impls.size, 2, 'run has Base impl (A, C inherit) and B override');
  t.equal(run.targets.get('A').className, 'Base', 'A inherits Base.run');
  t.equal(run.targets.get('C').className, 'Base', 'C inherits Base.run');
  t.equal(run.targets.get('B').className, 'B', 'B overrides run');
  t.notOk(run.targets.has('Base'), 'abstract Base is not a runtime receiver');

  const abs = h.resolveDispatch('Base', 'abs', '()I');
  t.equal(abs.impls.size, 2, 'abs implemented by A (C inherits) and B');
  t.equal(abs.targets.get('C').className, 'A', 'C inherits A.abs');
  t.end();
});

test('stub classes taint resolution instead of producing wrong targets', (t) => {
  const stub = cls('Mid', 'java/lang/Object');
  stub.isJreStub = true;
  const jvm = world({
    'java/lang/Object': cls('java/lang/Object', null),
    Mid: stub,
    Leaf: cls('Leaf', 'Mid', {}),
    Root: cls('Root', 'java/lang/Object', { methods: [['f', '()I', []]] }),
  });
  const h = new ClassHierarchy(jvm);
  t.equal(h.findImplementation('Leaf', 'f', '()I'), null,
    'walk-up through a stub resolves nothing');
  t.equal(h.resolveDispatch('Mid', 'f', '()I'), null,
    'stub owner yields no dispatch facts');
  t.end();
});

test('resolveSpecial binds private same-class and direct-superclass shapes only', (t) => {
  const jvm = world({
    'java/lang/Object': cls('java/lang/Object', null),
    Sup: cls('Sup', 'java/lang/Object', { methods: [['g', '(I)I', []]] }),
    Sub: cls('Sub', 'Sup', { methods: [['p', '(I)I', ['private']]] }),
    Deep: cls('Deep', 'Sub', {}),
  });
  const h = new ClassHierarchy(jvm);
  t.equal(h.resolveSpecial('Sub', 'Sub', 'p', '(I)I').className, 'Sub',
    'private same-class call binds');
  t.equal(h.resolveSpecial('Deep', 'Sub', 'p', '(I)I'), null,
    'private call from another class does not bind');
  t.equal(h.resolveSpecial('Sub', 'Sup', 'g', '(I)I').className, 'Sup',
    'super call to direct superclass binds');
  t.equal(h.resolveSpecial('Deep', 'Sup', 'g', '(I)I'), null,
    'owner farther than the direct superclass is not trusted');
  t.end();
});

test('epoch bump invalidates memoized dispatch facts', (t) => {
  const jvm = world({
    'java/lang/Object': cls('java/lang/Object', null),
    P: cls('P', 'java/lang/Object', { methods: [['f', '()I', []]] }),
  });
  const h = new ClassHierarchy(jvm);
  t.equal(h.resolveDispatch('P', 'f', '()I').impls.size, 1, 'one impl before load');
  jvm.classes.Q = cls('Q', 'P', { methods: [['f', '()I', []]] });
  jvm.classEpoch += 1;
  t.equal(h.resolveDispatch('P', 'f', '()I').impls.size, 2,
    'new subclass appears after the epoch bump');
  t.end();
});

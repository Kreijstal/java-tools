const test = require('tape');
const { JVM } = require('../src/core/jvm');

function registerClass(jvm, name, superClassName = 'java/lang/Object') {
  jvm.classes[name] = {
    staticFields: new Map(),
    ast: { classes: [{ name, superClassName, interfaces: [], items: [] }] },
  };
}

test('reference arrays obey JVM covariance in synchronous type checks', (t) => {
  const jvm = new JVM({ jit: { profileMethods: false } });
  registerClass(jvm, 'example/Base');
  registerClass(jvm, 'example/Child', 'example/Base');

  t.ok(jvm.isInstanceOf('[Lexample/Child;', '[Ljava/lang/Object;'),
    'an arbitrary reference array widens to Object[]');
  t.ok(jvm.isInstanceOf('[Lexample/Child;', '[Lexample/Base;'),
    'array covariance follows the component class hierarchy');
  t.ok(jvm.isInstanceOf('[[Lexample/Child;', '[[Ljava/lang/Object;'),
    'nested reference arrays widen recursively');
  t.ok(jvm.isInstanceOf('[[I', '[Ljava/lang/Object;'),
    'an array-valued component widens to Object');
  t.notOk(jvm.isInstanceOf('[I', '[Ljava/lang/Object;'),
    'a primitive component does not widen to Object');
  t.notOk(jvm.isInstanceOf('[Lexample/Base;', '[Lexample/Child;'),
    'array covariance does not permit narrowing');
  t.notOk(jvm.isInstanceOf('[I', '[J'),
    'primitive arrays require identical component types');
  t.ok(jvm.isInstanceOf('[I', 'java/lang/Cloneable') &&
      jvm.isInstanceOf('[I', 'java/io/Serializable'),
    'all arrays retain their JVM marker supertypes');
  t.end();
});

test('async and generated checkcast paths share reference-array covariance', async (t) => {
  const jvm = new JVM({ jit: { profileMethods: false } });
  registerClass(jvm, 'example/Element');
  const array = [];
  array.type = '[Lexample/Element;';

  t.ok(await jvm.isInstanceOfAsync(array.type, '[Ljava/lang/Object;'),
    'the loading-aware hierarchy path accepts Object[]');
  t.equal(jvm.jit.tryCheckCastSync(array, '[Ljava/lang/Object;'), true,
    'generated checkcast accepts the same widening conversion');

  let thrown = null;
  try {
    jvm.jit.tryCheckCastSync(array, '[Ljava/lang/String;');
  } catch (error) {
    thrown = error;
  }
  t.equal(thrown?.type, 'java/lang/ClassCastException',
    'an unrelated reference-array cast still throws');
  t.equal(thrown?.message,
    '[Lexample/Element; cannot be cast to [Ljava/lang/String;',
  'the failed cast retains the precise source and target descriptors');
  t.end();
});

test('generated array casts defer an unloaded component hierarchy', (t) => {
  const jvm = new JVM({ jit: { profileMethods: false } });
  const array = [];
  array.type = '[Lexample/LateChild;';

  t.equal(
    jvm.jit.tryCheckCastSync(array, '[Lexample/LateBase;'),
    jvm.jit.asyncInvokeSentinel(),
    'an unresolved component type deoptimizes instead of throwing a false cast error',
  );
  registerClass(jvm, 'example/LateBase');
  registerClass(jvm, 'example/LateChild', 'example/LateBase');
  t.equal(jvm.jit.tryCheckCastSync(array, '[Lexample/LateBase;'), true,
    'the same cast succeeds after the component hierarchy loads');
  t.end();
});

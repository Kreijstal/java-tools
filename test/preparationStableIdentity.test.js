// The class-record identity invariant (JVM.upgradeStubClassInPlace): a body
// prepared against an applicationFallback stub keeps observing the real class
// correctly after the class file is loaded, through every identity it can
// hold -- the record, the static store and its cells, the Class object, the
// initialization token -- because the stub is filled in place rather than
// replaced. Class initialization still happens at its Java-visible point.
'use strict';
const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JVM } = require('../src/core/jvm');
const frontend = require('../src/java-frontend');

function compileFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-identity-'));
  t.teardown(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.writeFileSync(path.join(dir, 'FallbackTarget.java'), [
    'public class FallbackTarget {',
    '  static int counter;',
    '  static int[] table;',
    '  static int initRuns;',
    '  static { initRuns++; counter = 100; table = new int[4]; table[3] = 7; }',
    '  int field;',
    '  FallbackTarget(int v) { field = v; }',
    '  static int bump(int d) { counter += d; return counter; }',
    '  int get() { return field + table[3]; }',
    '  static int host(int x) { return -1; }', // replaced by the override
    '}',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'FallbackUser.java'), [
    'public class FallbackUser {',
    '  static int result;',
    '  static int initSeen;',
    // The body prepared against the stub. It cannot construct FallbackTarget
    // itself: an unloaded constructor is a pending dependency the admission
    // rightly refuses (see the fixed-point test); the instances come in.
    '  static int probe(int n, FallbackTarget[] ts) {',
    '    int s = 0;',
    '    for (int i = 0; i < n; i++) {',
    '      FallbackTarget.counter += 1;',
    '      FallbackTarget t = ts[i];',
    '      s += t.get();',
    '      s += FallbackTarget.bump(1);',
    '      s += FallbackTarget.host(i);',
    '      if (t instanceof FallbackTarget) s += 1;',
    '      Class c = FallbackTarget.class;',
    '      if (c != null) s += 1;',
    '    }',
    '    return s;',
    '  }',
    '  static FallbackTarget[] make(int n) {',
    '    FallbackTarget[] ts = new FallbackTarget[n];',
    '    for (int i = 0; i < n; i++) ts[i] = new FallbackTarget(i);',
    '    return ts;',
    '  }',
    '  public static void main(String[] args) {',
    '    FallbackTarget[] ts = make(10);',
    '    initSeen = FallbackTarget.initRuns;',
    '    result = probe(10, ts);',
    '  }',
    '}',
  ].join('\n'));
  for (const name of ['FallbackTarget', 'FallbackUser']) {
    frontend.compileJavaFile(path.join(dir, `${name}.java`),
      {outputDir: dir, sourceFileName: `${name}.java`});
  }
  return dir;
}

// What the program computes, worked out here rather than trusted from a run.
function expected(n) {
  let counter = 100, s = 0;
  for (let i = 0; i < n; i++) {
    counter += 1;
    s += i + 7;             // t.get(): field + table[3]
    counter += 1; s += counter;
    s += i * 2;             // host(i) via the override
    s += 1;                 // instanceof
    s += 1;                 // class literal
  }
  return {result: s, counter};
}

const overrides = {
  FallbackTarget: {
    natives: {applicationFallback: true},
    methods: {'host(I)I': (jvm, _, args) => (args[0] | 0) * 2},
  },
};

function findMethod(jvm, className, name, descriptor) {
  return jvm.classes[className].ast.classes[0].items
    .find((item) => item.type === 'method' && item.method.name === name &&
      item.method.descriptor === descriptor).method;
}

test('a body prepared against the fallback stub keeps observing the real class after the in-place upgrade', async (t) => {
  const dir = compileFixture(t);
  const jvm = new JVM({classpath: dir, prepareBeforeMain: false,
    jit: {compileWorker: false, asyncCallCensus: true}, jreOverrides: overrides});
  const stub = jvm.classes.FallbackTarget;
  t.ok(stub && stub.isJreStub, 'the override registers FallbackTarget as a stub');
  const store = stub.staticFields;
  const counterCell = store.cell('counter:I');
  const classObject = jvm.getClassObjectSync('FallbackTarget');
  t.equal(classObject._classData, stub, 'the Class object holds the stub record');
  const token = jvm.getClassInitializationToken('FallbackTarget');

  // Prepare the user against the stub, by hand, before anything loads the
  // real class: this is the body whose captured identities are under test.
  await jvm.loadClassByName('FallbackUser');
  t.ok(jvm.classes.FallbackTarget.isJreStub, 'loading the user did not touch the stub');
  const probe = findMethod(jvm, 'FallbackUser', 'probe', '(I[LFallbackTarget;)I');
  const body = jvm.jit.getGeneratedFunction(probe, {allowEffectfulCalls: true, compileLocally: true});
  t.ok(body && jvm.jit.preparedCodegenMethods.has(probe), 'probe has a prepared body' + (body ? '' : ': ' + (jvm.jit.codegenCompileErrors.get(probe) || 'declined')));
  t.ok(jvm.classes.FallbackTarget.isJreStub, 'and compiling it left FallbackTarget a stub');
  t.notEqual(jvm.classInitializationState.get('FallbackTarget'), 'INITIALIZED',
    'preparation did not initialize the class');

  await jvm.run('FallbackUser', {prepare: false});

  const real = jvm.classes.FallbackTarget;
  t.equal(real, stub, 'the real class is the same record object the stub was');
  t.equal(real.isJreStub, undefined, 'and it is no longer a stub');
  t.ok(real.ast.classes[0].items.some((item) => item.type === 'method' && item.method.name === 'bump'),
    'it carries the real bytecode members');
  t.equal(real.staticFields, store, 'the static store is the one the stub had');
  t.equal(store.cell('counter:I'), counterCell, 'and its cells are the cells handed out against the stub');
  t.equal(jvm.getClassObjectSync('FallbackTarget'), classObject, 'the Class object identity is unchanged');
  t.equal(classObject._classData, real, 'and it points at the (filled) record');
  t.equal(jvm.getClassInitializationToken('FallbackTarget'), token, 'the initialization token is unchanged');
  t.equal(token.initialized, true, 'and reports the class initialized after main');
  t.equal(jvm.jit.codegenCache.get(probe), body, 'the SAME prepared body is still installed');

  const want = expected(10);
  t.equal(jvm.classes.FallbackUser.staticFields.get('result:I'), want.result,
    'the prepared body computed the right result through statics, constructor, virtual, static, override, instanceof and class literal');
  t.equal(store.get('counter:I'), want.counter, 'the static it wrote is the one it read back (through the <clinit> value)');
  t.equal(store.get('initRuns:I'), 1, '<clinit> ran exactly once');
  t.equal(jvm.classes.FallbackUser.staticFields.get('initSeen:I'), 1,
    'and at its Java-visible point: the first active use in main(), not during preparation');
  t.end();
});

test('run() with preparation on prepares against the real class: the preload upgrades the stub before compiling', async (t) => {
  const dir = compileFixture(t);
  const jvm = new JVM({classpath: dir, prepareBeforeMain: true,
    jit: {compileWorker: false}, jreOverrides: overrides});
  const stub = jvm.classes.FallbackTarget;
  const store = stub.staticFields;
  await jvm.run('FallbackUser');
  t.equal(jvm.classes.FallbackTarget, stub, 'same record');
  t.equal(jvm.classes.FallbackTarget.staticFields, store, 'same store');
  t.ok(jvm.preparationReport && jvm.preparationReport.upgradedStubClasses >= 1,
    'the preparation report counts the upgraded stub');
  const bump = findMethod(jvm, 'FallbackTarget', 'bump', '(I)I');
  t.ok(jvm.jit.preparedCodegenMethods.has(bump), 'the real class\'s methods were prepared (the stub no longer hides them)');
  const want = expected(10);
  t.equal(jvm.classes.FallbackUser.staticFields.get('result:I'), want.result, 'correct result');
  t.equal(store.get('initRuns:I'), 1, '<clinit> ran once, after preparation');
  t.end();
});

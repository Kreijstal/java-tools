'use strict';
const test = require('tape');
const {JVM} = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');
const compile = require('./javaFixture').makeJavaFixtureCompiler('prepared-constructor-');

test('preparation verifies cold constructor callers without an array loop', async t => {
  const classpath = compile(t, 'ColdConstructorCaller', `
public class ColdConstructorCaller {
  static int effects, result;
  static class Child {
    int value;
    Child(int n) { effects++; value = compute(n); }
    static int compute(int n) { if (n < 0) throw new IllegalArgumentException(); return n + 3; }
  }
  static void call(boolean allocate, int n) {
    effects += 10;
    try { result = allocate ? new Child(n).value : 7; }
    catch (IllegalArgumentException ex) { result = -9; }
    effects += 100;
  }
}`);
  const jvm = new JVM({classpath, jit: {compileWorker: false,
    warmupThreshold: 0, structuredSsa: true, preferWholeMethodJs: true, compiledCallChains: true}});
  jvm.jit.wasmJit.enabled = false;
  await jvm.loadClassByName('ColdConstructorCaller');
  await jvm.loadClassByName('ColdConstructorCaller$Child');
  const jit = jvm.jit;
  const method = await jvm.findMethodInHierarchy('ColdConstructorCaller', 'call', '(ZI)V');
  t.equal(jit.hasOnlyJitSafeInitializationCalls(jit.getCodeItems(method)), false,
    'fixture contains an unproven constructor');
  jit.effectfulPreparationActive = true;
  t.ok(jit.isCodegenSupported(method, true), 'preparation admits structured verification');
  t.ok(jit.structuredOnlyCodegenMethods.has(method), 'baseline replay remains forbidden');
  const generated = jit.getGeneratedFunction(method, {allowEffectfulCalls: true, compileLocally: true});
  jit.effectfulPreparationActive = false;
  jit.adaptiveCodegenSupportCache = new WeakMap();
  t.ok(jit.isCodegenSupported(method, true), 'verified admission survives the preparation boundary');
  t.equal(jit.getGeneratedFunction(method), generated, 'runtime retains the prepared entry');
  // Persistent cache installation restores the body and prepared membership,
  // but does not rerun the compiler's admission analysis.
  jit.structuredOnlyCodegenMethods.delete(method);
  jit.adaptiveCodegenSupportCache = new WeakMap();
  t.equal(jit.getGeneratedFunction(method), generated, 'restored structured body remains executable');
  t.ok(jit.structuredOnlyCodegenMethods.has(method), 'restoration recovers the no-baseline restriction');
  jit.adaptiveCodegenSupportCache.set(method, false);
  t.equal(jit.getGeneratedFunction(method), generated,
    'a stale admission rejection cannot hide a verified prepared body');
  jit.adaptiveCodegenSupportCache.delete(method);
  jit.adaptiveCodegenDependencyPending.add(method);
  jit.adaptiveCodegenDependencyEpoch.set(method, jvm.classEpoch || 0);
  t.equal(jit.getGeneratedFunction(method), generated,
    'a stale dependency wait cannot hide a verified prepared body');
  jit.adaptiveCodegenDependencyPending.delete(method);
  jit.adaptiveCodegenDependencyEpoch.delete(method);
  jit.adaptiveCodegenSupportCache.delete(method);
  t.ok(generated?.jvmStructuredSsa, 'caller compiles with exact continuations');
  if (!generated) { t.end(); return; }
  let entries = 0;
  const counted = function (...args) { entries++; return generated.apply(this, args); };
  Object.assign(counted, generated);
  jit.codegenCache.set(method, counted);
  const thread = {id: 0, name: 'test', callStack: new Stack(), status: 'runnable', pendingException: null};
  jvm.threads = [thread]; jvm.currentThreadIndex = 0;
  const fields = jvm.classes.ColdConstructorCaller.staticFields;
  for (const [allocate, n, expected, effects] of [[0, 4, 7, 110], [1, 4, 7, 111], [1, -1, -9, 111], [0, 2, 7, 110]]) {
    const before = entries;
    fields.set('effects:I', 0);
    const frame = new Frame(method); frame.className = 'ColdConstructorCaller';
    frame.locals[0] = allocate; frame.locals[1] = n; thread.callStack.push(frame);
    let ticks = 0;
    while (!thread.callStack.isEmpty()) {
      await jvm.executeTick();
      if (++ticks > 10000) throw new Error('caller did not complete');
    }
    t.ok(entries > before, 'the compiled caller actually executes');
    t.equal(fields.get('result:I'), expected, `branch ${allocate}/${n} preserves result or handler`);
    t.equal(fields.get('effects:I'), effects, 'allocation and surrounding effects execute exactly once');
    t.equal(thread.pendingException, null, 'no uncaught exception');
  }
  const original = jit.structuredSsa.compile;
  jit.structuredSsa.compile = () => null;
  t.equal(jit.compileMethod(method), null, 'failed proof cannot fall through to baseline');
  jit.structuredSsa.compile = () => ({jvmStructuredSsa: true, jvmStructuredRequiresBaselineFramedEntry: true});
  t.equal(jit.compileMethod(method), null, 'baseline-only framed entry remains rejected');
  jit.structuredSsa.compile = original;
  t.end();
});

test('cold constructor admission preserves runtime and option gates', t => {
  const method = {name: 'coldBranch', descriptor: '()V', flags: ['static'], attributes: [{type: 'code', code: {
    codeItems: ['return'].map(instruction => ({instruction})), exceptionTable: [], localsSize: '0', stackSize: '0',
  }}]};
  for (const [preparing, enabled, expected] of [[false, true, false], [true, false, false], [true, true, true]]) {
    const jit = new JVM({jit: {compileWorker: false, structuredSsa: true,
      structuredUnsafeConstructorCallers: enabled}}).jit;
    jit.hasOnlyJitSafeInitializationCalls = () => false;
    jit.effectfulPreparationActive = preparing;
    t.equal(jit.isCodegenSupported(method, true), expected,
      `preparing=${preparing}, structured constructor callers=${enabled}`);
  }
  t.end();
});

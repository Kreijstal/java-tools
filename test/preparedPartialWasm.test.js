'use strict';
const test = require('tape');
const {JVM} = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const CallStack = require('../src/core/callStack');
const fixture = require('./javaFixture').makeJavaFixtureCompiler('prepared-partial-wasm-');

test('partial preparation policy validates and remains opt-in', t => {
  for (const value of [true, 'Owner.loop()V', [null], [''], ['  ']]) {
    t.throws(() => new JVM({jit: {compileWorker: false, preparedPartialWasmMethods: value}}),
      /preparedPartialWasmMethods must be an array of nonempty method identities/);
  }
  const method = {className: 'Owner', name: 'loop', descriptor: '()V'};
  const selected = new JVM({jit: {compileWorker: false,
    preparedPartialWasmMethods: ['Owner.loop()V']}}).jit;
  const ordinary = new JVM({jit: {compileWorker: false}}).jit;
  t.ok(selected.isPreparedWasmMethodSelected(method), 'partial selection participates in preparation');
  t.notOk(ordinary.isPreparedWasmMethodSelected(method), 'other runtimes retain defaults');
  t.notOk(selected.isPreparedWasmMethodSelected({...method, descriptor: '(I)V'}), 'overloads are independent');
  t.end();
});

test('selected partial prepared loop preserves cold continuation and exit-storm fallback', async t => {
  const classpath = fixture(t, 'PartialKernel', `public class PartialKernel {
    static class Box { static int seed = 11; int x = seed; }
    static void kernel(int[] values, boolean cold) {
      for (int i=0; i<values.length; i++) values[i] += 3;
      if (cold) values[0] += new Box().x;
    }
    public static void call(int[] values, boolean cold) { kernel(values, cold); }
  }`);
  const j = new JVM({classpath, prepareBeforeMain: false, jit: {
    compileWorker: false, preferWholeMethodJs: true, wasmStructured: true,
    structuredSsa: true, rendererPipeline: true, compiledCallChains: true,
    preparedPartialWasmMethods: ['PartialKernel.kernel([IZ)V']}});
  await j.preloadClasspathClasses(); j._setClassInitializationState('PartialKernel', 'INITIALIZED');
  const jit = j.jit, w = jit.wasmJit; w.enabled = true;
  const method = await j.findMethodInHierarchy('PartialKernel', 'kernel', '([IZ)V');
  const caller = await j.findMethodInHierarchy('PartialKernel', 'call', '([IZ)V');
  t.notOk(jit.hasPreparedFullWasmUpgrade(method), 'cold module is not selected');
  await j.precompileInitializedClasses({effectful: true, wasm: true, fixedPoint: true,
    wasmPreparedUpgradesOnly: true, wasmFallbackOnly: true});
  const state = w.state.get(method);
  t.equal(state.status, 'ready', 'explicit partial loop is prepared');
  t.notOk(state.meta.fullyCompiled, 'cold allocation keeps partial coverage');
  t.ok(jit.hasPreparedPartialWasmUpgrade(method), 'prepared executable partial entry is selected');
  state.runs = 64; state.exits = 32;
  t.notOk(jit.hasPreparedFullWasmUpgrade(method), 'exit storm overrides explicit selection');
  state.runs = 0; state.exits = 0;
  const entry = state.meta.blockOfItem.get(0);
  state.meta.externalEntry.delete(entry);
  t.notOk(jit.hasPreparedFullWasmUpgrade(method), 'missing executable entry retains fallback');
  state.meta.externalEntry.add(entry);
  state.status = 'cold';
  t.notOk(jit.hasPreparedFullWasmUpgrade(method), 'withdrawn module retains fallback');
  state.status = 'ready';
  const entries = [], execute = w.execute;
  w.execute = function(frame, ...args) {
    const result = execute.call(this, frame, ...args);
    if (frame.method === method) entries.push({returned: result?.returned, pc: frame.pc});
    return result;
  };
  const thread = {id: 1, status: 'runnable', pendingException: null, callStack: new CallStack()};
  j.threads = [thread]; j.currentThreadIndex = 0;
  const values = new Int32Array([1, 2, 3, 4]);
  for (const cold of [0, 0, 1]) {
    const frame = new Frame(caller); frame.className = 'PartialKernel';
    frame.locals[0] = values; frame.locals[1] = cold; thread.callStack.push(frame);
    let ticks = 0;
    while (thread.callStack.size() && ++ticks < 10000) await j.executeTick();
    t.ok(ticks < 10000, 'generated caller and canonical continuation finish');
  }
  t.deepEqual([...values], [21, 11, 12, 13], 'cold continuation does not repeat earlier loop writes');
  t.ok(entries.filter(entry => entry.returned).length >= 2, 'warm calls finish in primary Wasm');
  t.ok(entries.some(entry => !entry.returned && entry.pc > 0), 'cold branch exits after its completed effects');
  t.end();
});

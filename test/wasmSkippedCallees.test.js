'use strict';
const test = require('tape');
const {JVM} = require('../src/core/jvm');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const fixture = makeJavaFixtureCompiler('wasm-skipped-callees-');

// After main(), one compile may hold the guest's turn only so long; past the
// budget, on-demand callee compiles are skipped. Deko Bloko's mixer linked a
// factory whose constructor was skipped that way, and with nothing asking
// again the mixer kept exiting Wasm at that call. Skipped callees are queued,
// compiled later one per turn, and the partial modules waiting on them are
// rebuilt.
for (const queue of [true, false]) {
  test(`budget-skipped callees ${queue ? 'are compiled later' : 'stay cold with the queue off'}`, async t => {
    const priorInline = process.env.JVM_WASM_INLINE;
    process.env.JVM_WASM_INLINE = '0';
    t.teardown(() => {
      if (priorInline === undefined) delete process.env.JVM_WASM_INLINE;
      else process.env.JVM_WASM_INLINE = priorInline;
    });
    const classpath = fixture(t, 'SkippedCallees', `public class SkippedCallees {
      int v = 3;
      int leaf(int n) { return n + v; }
      int mid(int n) { return leaf(n) * 2; }
      static int work(SkippedCallees self, int n) {
        int sum = 0;
        for (int i = 0; i < n; i++) sum += self.mid(i);
        return sum;
      }
    }`);
    const j = new JVM({classpath, jit: {compileWorker: false, wasmStructured: true,
      postMainCompileBudgetMs: 1e-6, wasm: {skippedCalleeQueue: queue}}});
    await j.preloadClasspathClasses();
    j._setClassInitializationState('SkippedCallees', 'INITIALIZED');
    j.guestStarted = true;
    const w = j.jit.wasmJit;
    const state = async (name, descriptor) => w.methodState({
      method: await j.findMethodInHierarchy('SkippedCallees', name, descriptor)});
    const work = await state('work', '(LSkippedCallees;I)I');
    const method = await j.findMethodInHierarchy('SkippedCallees', 'work', '(LSkippedCallees;I)I');
    w.compile({method, className: 'SkippedCallees'}, work, {entryPath: 'warmup'});
    const mid = await state('mid', '(I)I');
    // The loop's only work is the call, so the caller has no compiled loop
    // yet and waits on the callee.
    t.equal(work.status, 'cold', 'the caller is deferred');
    t.deepEqual(work.blockers, ['SkippedCallees.mid(I)I'], 'waiting on the callee');
    t.equal(mid.status, 'cold', 'the budget skipped the callee');
    if (!queue) {
      t.notOk(w.skippedCalleeOrder && w.skippedCalleeOrder.length, 'nothing is queued');
      t.end();
      return;
    }
    t.ok(w.skippedCalleeOrder.length >= 1, 'the skipped callee is queued');
    w.drainSkippedCallees();
    const leaf = await state('leaf', '(I)I');
    t.equal(mid.status, 'ready', 'the callee compiled from the queue');
    t.equal(leaf.status, 'ready', 'and so did its own callee');
    t.equal(work.status, 'ready', 'the waiting caller compiled from the queue');
    t.ok(work.meta && work.meta.fullyCompiled, 'with the call linked');
    t.deepEqual(work.blockers, [], 'nothing blocks it any more');
    t.end();
  });
}

// A browser launcher freezes compilation after preparation: published code
// is never replaced, but callee-link compiles still run. The queue follows
// the same rule instead of dropping what it holds.
test('budget-skipped callees still compile while compilation is frozen', async t => {
  const priorInline = process.env.JVM_WASM_INLINE;
  process.env.JVM_WASM_INLINE = '0';
  t.teardown(() => {
    if (priorInline === undefined) delete process.env.JVM_WASM_INLINE;
    else process.env.JVM_WASM_INLINE = priorInline;
  });
  const classpath = fixture(t, 'FrozenSkipped', `public class FrozenSkipped {
    int v = 3;
    int leaf(int n) { return n + v; }
    static int work(FrozenSkipped self, int n) {
      int sum = 0;
      for (int i = 0; i < n; i++) sum += self.leaf(i);
      return sum;
    }
  }`);
  const j = new JVM({classpath, jit: {compileWorker: false, wasmStructured: true,
    postMainCompileBudgetMs: 1e-6}});
  await j.preloadClasspathClasses();
  j._setClassInitializationState('FrozenSkipped', 'INITIALIZED');
  j.guestStarted = true;
  const w = j.jit.wasmJit;
  const method = await j.findMethodInHierarchy('FrozenSkipped', 'work', '(LFrozenSkipped;I)I');
  w.compile({method, className: 'FrozenSkipped'}, w.methodState({method}), {entryPath: 'warmup'});
  w.compilationFrozen = true;
  w.drainSkippedCallees();
  const leaf = w.state.get(await j.findMethodInHierarchy('FrozenSkipped', 'leaf', '(I)I'));
  t.equal(leaf && leaf.status, 'ready', 'the skipped callee compiled under the freeze');
  t.end();
});

// A reference-returning factory compiled before its class is initialized is
// deferred on that class. It is retried only from a later compile epoch,
// which never comes while compilation is frozen and nothing else compiles;
// the class's initialization queues it instead.
test('a callee deferred on class initialization compiles when the class initializes', async t => {
  const classpath = fixture(t, 'LateFactory', `public class LateFactory {
    static int seed = 7;
    int v;
    LateFactory(int v) { this.v = v + seed; }
    static LateFactory make(int v) { return new LateFactory(v); }
  }`);
  const j = new JVM({classpath, jit: {compileWorker: false, wasmStructured: true}});
  await j.preloadClasspathClasses();
  j.guestStarted = true;
  const w = j.jit.wasmJit;
  w.compilationFrozen = true;
  const method = await j.findMethodInHierarchy('LateFactory', 'make', '(I)LLateFactory;');
  const state = w.methodState({method});
  w.compile({method, className: 'LateFactory'}, state, {asCallee: true});
  t.equal(state.status, 'cold', 'deferred while the class is uninitialized');
  t.deepEqual(state.calleeBlockers, ['LateFactory'], 'waiting on the class');
  j._setClassInitializationState('LateFactory', 'INITIALIZED');
  t.ok(w.skippedCalleeOrder && w.skippedCalleeOrder.length, 'initialization queued it');
  w.drainSkippedCallees();
  t.equal(state.status, 'ready', 'compiled from the queue under the freeze');
  t.end();
});

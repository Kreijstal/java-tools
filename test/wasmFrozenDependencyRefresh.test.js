'use strict';
const test = require('tape');
const {JVM} = require('../src/core/jvm');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const fixture = makeJavaFixtureCompiler('wasm-frozen-refresh-');

for (const restriction of ['frozen', 'post-main']) {
  test(`normal dependency refresh preserves published module when ${restriction}`, async t => {
    const priorInline = process.env.JVM_WASM_INLINE;
    process.env.JVM_WASM_INLINE = '0';
    t.teardown(() => {
      if (priorInline === undefined) delete process.env.JVM_WASM_INLINE;
      else process.env.JVM_WASM_INLINE = priorInline;
    });
    const classpath = fixture(t, 'FrozenRefresh', `public class FrozenRefresh {
      int leaf(int n) { return n + 1; }
      static int work(FrozenRefresh self, int n) {
        int sum = 0;
        for (int i = 0; i < n; i++) sum += self.leaf(i);
        return sum;
      }
    }`);
    const j = new JVM({classpath, jit: {compileWorker: false, wasmStructured: true}});
    await j.preloadClasspathClasses();
    j._setClassInitializationState('FrozenRefresh', 'INITIALIZED');
    const w = j.jit.wasmJit;
    w.noOnDemandCalleeCompile = true;
    const compile = async (name, descriptor) => {
      const method = await j.findMethodInHierarchy('FrozenRefresh', name, descriptor);
      const state = w.methodState({method});
      w.compile({method, className:'FrozenRefresh'}, state, {asCallee:true});
      t.equal(state.status, 'ready', name + ' is installed');
      return state;
    };
    const state = await compile('work', '(LFrozenRefresh;I)I');
    const original = state.meta;
    const originalRun = state.run;
    t.ok(state.partialDeps, 'caller has a genuine pending dependency');
    await compile('leaf', '(I)I');
    t.ok(w.depsMoved(state), 'dependency is now available');
    w.compilationFrozen = restriction === 'frozen';
    j.guestStarted = restriction === 'post-main';
    w.refusePostMainCompiles = restriction === 'post-main';
    t.equal(w.refreshPartialDependencies(state), false, 'normal entry does not withdraw the module');
    t.equal(state.status, 'ready', 'installed module remains ready');
    t.ok(state.meta === original && state.run === originalRun, 'published code remains usable');
    t.equal(state.depRecompiles || 0, 0, 'blocked refresh does not consume its retry allowance');
    w.compilationFrozen = false;
    j.guestStarted = false;
    w.refusePostMainCompiles = false;
    t.equal(w.refreshPartialDependencies(state), true, 'dependency refresh remains pending until allowed');
    t.equal(state.depRecompiles, 1, 'allowed refresh consumes one retry');
    t.end();
  });
}

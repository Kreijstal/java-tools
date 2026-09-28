'use strict';
const test = require('tape');
const {JVM} = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const CallStack = require('../src/core/callStack');
const fixture = require('./javaFixture').makeJavaFixtureCompiler('prepared-wasm-callees-');

test('explicit preparation includes only selected non-loop Wasm callees', async t => {
  const classpath = fixture(t, 'PreparedCallee', `public class PreparedCallee {
    static int leaf(int x) { return x * 3 + 1; }
    static int unrelated(int x) { return x + 9; }
    static int loop(int n) { int total = 0; for (int i=0; i<n; i++) total += leaf(i); return total; }
  }`);
  const j = new JVM({classpath, prepareBeforeMain: false, jit: {
    compileWorker: false, wasmStructured: true, structuredSsa: true,
    rendererPipeline: true, compiledCallChains: true,
    preparedWasmMethods: ['PreparedCallee.loop(I)I'],
    wasm: {noOnDemandCalleeCompile: true, maxInlineCalleeItems: 1, inlineBudget: 1}}});
  await j.preloadClasspathClasses(); j._setClassInitializationState('PreparedCallee', 'INITIALIZED');
  const w = j.jit.wasmJit; w.enabled = true;
  for (const value of [true, 'PreparedCallee.leaf(I)I', [null], ['']]) {
    let error;
    try { await j.precompileInitializedClasses({preparationPolicy: {wasmCalleeMethods: value}}); }
    catch (caught) { error = caught; }
    t.ok(error instanceof TypeError && /preparationPolicy.wasmCalleeMethods/.test(error.message),
      'malformed callee policy is rejected');
  }
  const leaf = await j.findMethodInHierarchy('PreparedCallee', 'leaf', '(I)I');
  await j.precompileInitializedClasses({effectful: true, wasm: true,
    preparationPolicy: {maxMethods: 0, wasmCalleeMethods: ['PreparedCallee.leaf(I)I']}});
  t.notEqual(w.state.get(leaf)?.status, 'ready', 'explicit callee respects the overall method budget');
  await j.precompileInitializedClasses({effectful: true, wasm: true, fixedPoint: true,
    wasmPreparedUpgradesOnly: true, wasmFallbackOnly: true,
    preparationPolicy: {priorityMethods: ['PreparedCallee.loop(I)I', 'PreparedCallee.leaf(I)I'],
      wasmCalleeMethods: ['PreparedCallee.leaf(I)I']}});
  const loop = await j.findMethodInHierarchy('PreparedCallee', 'loop', '(I)I');
  const unrelated = await j.findMethodInHierarchy('PreparedCallee', 'unrelated', '(I)I');
  t.equal(w.state.get(leaf)?.status, 'ready', 'loop-only preparation explicitly includes the measured helper');
  t.notEqual(w.state.get(unrelated)?.status, 'ready', 'unlisted non-loop method is not compiled');
  t.notOk(j.jit.hasPreparedFullWasmUpgrade(leaf), 'callee preparation does not change root tier preference');
  t.equal(w.noOnDemandCalleeCompile, true, 'preparation does not relax on-demand compilation policy');
  const state = w.state.get(loop);
  t.equal(state?.status, 'ready', 'selected caller is prepared');
  t.equal(state.meta.inlinedCalls || 0, 0, 'fixture executes the real callee link');
  w.compilationFrozen = true;
  // The legacy freeze only gates warmup. Trap every compiler entry too, so
  // this test cannot silently rely on an on-demand callee compilation.
  w.compile = () => { throw new Error('unexpected compilation during prepared execution'); };
  const frame = new Frame(loop); frame.className = 'PreparedCallee'; frame.locals[0] = 100;
  const thread = {id: 1, status: 'runnable', callStack: new CallStack()}; thread.callStack.push(frame);
  const result = w.execute(frame, thread, state, 0);
  t.ok(result.returned, 'prepared call chain completes without any compiler entry');
  t.equal(result.value, 14950, 'linked helper returns exact loop result');
  t.end();
});

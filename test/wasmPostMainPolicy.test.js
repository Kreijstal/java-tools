'use strict';
const test = require('tape');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');
const {JVM} = require('../src/core/jvm');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const fixture = makeJavaFixtureCompiler('wasm-post-main-policy-');

test('post-main compilation policy validates and reports enforcement', t => {
  t.throws(() => new JVM({jit: {wasm: {refusePostMainCompiles: 'true'}}}), /must be a boolean/);
  const w = new JVM({jit: {wasm: {refusePostMainCompiles: false}}}).jit.wasmJit;
  w.freezeCompilation();
  t.equal(w.postMainCompileCensus().executionOnly, false, 'warmup freeze does not promise execution-only');
  t.end();
});

test('post-main policy preserves prepared bodies and refuses every compiler entry', async t => {
  const classpath = fixture(t, 'PostMainPolicy', `public class PostMainPolicy {
    static int leaf(int n) { return n + 7; }
    static int cold(int n) { return n * 3; }
  }`);
  const j = new JVM({classpath, jit: {compileWorker: false, wasmStructured: true,
    wasm: {refusePostMainCompiles: true}}});
  await j.preloadClasspathClasses();
  j._setClassInitializationState('PostMainPolicy', 'INITIALIZED');
  const w = j.jit.wasmJit;
  const method = await j.findMethodInHierarchy('PostMainPolicy', 'leaf', '(I)I');
  const frame = {className: 'PostMainPolicy', method};
  const state = w.methodState(frame);
  w.compile(frame, state, {asCallee:true});
  t.equal(state.status, 'ready', 'preparation is allowed');
  const run = state.run, meta = state.meta;
  j.guestStarted = true;
  w._compileUntimed = () => { throw new Error('foreground compiler entered'); };
  for (const entryPath of ['warmup', 'static-callee-link', 'instance-callee-link', 'storm-recompile']) {
    w.compile(frame, state, {entryPath});
    t.equal(state.run, run, entryPath + ' keeps installed body');
    t.equal(state.meta, meta, entryPath + ' keeps execution metadata');
  }
  const cold = await j.findMethodInHierarchy('PostMainPolicy', 'cold', '(I)I');
  const coldFrame = {className:'PostMainPolicy', method:cold};
  const coldState = w.methodState(coldFrame);
  const prior = coldState.status;
  w.compile(coldFrame, coldState, {asCallee:true});
  t.equal(coldState.status, prior, 'refusal does not poison cold fallback');
  const readyFrame = new Frame(method);
  readyFrame.className = 'PostMainPolicy'; readyFrame.locals[0] = 5;
  const thread = {id:1, status:'runnable', callStack:new Stack()};
  thread.callStack.push(readyFrame);
  const result = w.execute(readyFrame, thread, state, 0);
  t.equal(result.returned, true, 'prepared method still executes');
  t.equal(state.meta.box.ret, 12, 'prepared result remains correct');
  thread.callStack.items.length = 0;
  const fallback = new Frame(cold);
  fallback.className = 'PostMainPolicy'; fallback.locals[0] = 5;
  thread.callStack.push(fallback);
  let returned;
  while (!thread.callStack.isEmpty()) {
    const f = thread.callStack.peek(), ins = f.instructions[f.pc++].instruction;
    if ((typeof ins === 'string' ? ins : ins?.op) === 'ireturn') returned = f.stack.peek();
    if (ins) await j.executeInstruction(ins, f, thread);
  }
  t.equal(returned, 15, 'cold method executes through interpreter fallback');
  t.deepEqual(w.postMainCompileCensus().compiled, {}, 'no post-main compiles');
  t.equal(w.postMainCompileCensus().executionOnly, true, 'enforcement reported');
  t.end();
});

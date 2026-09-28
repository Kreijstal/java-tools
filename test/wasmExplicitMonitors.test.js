'use strict';
const test = require('tape');
const {JVM} = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const CallStack = require('../src/core/callStack');
const {supportsWasmTryTable} = require('../src/jit/wasmShared');
const compileJava = require('./javaFixture').makeJavaFixtureCompiler('wasm-explicit-monitors-');

test('structured Wasm explicit monitors preserve effects, contention and exceptional cleanup', async t => {
  const classpath = compileJava(t, 'ExplicitMonitors', `
public class ExplicitMonitors {
  static int calls;
  static int read(Object lock, int[] values) {
    synchronized (lock) { calls++; return values[0]; }
  }
  static int caller(Object lock, int[] values) { return 9 + read(lock, values); }
}`);
  const j = new JVM({classpath, jit: {compileWorker: false, wasmStructured: true}});
  await j.preloadClasspathClasses();
  j.classes.ExplicitMonitors.staticFields.set('calls:I', 0);
  j._setClassInitializationState('ExplicitMonitors', 'INITIALIZED');
  const w = j.jit.wasmJit;
  const compile = async name => {
    const method = await j.findMethodInHierarchy('ExplicitMonitors', name, '(Ljava/lang/Object;[I)I');
    const state = w.methodState({method});
    w.compile({method, className: 'ExplicitMonitors'}, state, {asCallee: true});
    t.equal(state.status, 'ready', name + ' compiles');
    return {method, state};
  };
  const read = await compile('read');
  if (!supportsWasmTryTable()) { t.comment('protected body requires native EH'); t.end(); return; }
  t.ok(read.state.meta.normalFlowFullyCompiled, 'monitor instructions do not demote normal flow');
  t.ok(read.state.meta.usedEh, 'synchronized cleanup retains exception dispatch');
  t.ok(read.state.meta.deoptableCalls >= 2, 'monitor sites require canonical spill frames');
  const caller = await compile('caller');
  const invoke = (compiled, lock, values) => {
    const frame = new Frame(compiled.method); frame.className = 'ExplicitMonitors';
    frame.locals[0] = lock; frame.locals[1] = values;
    const thread = {id: 7, status: 'runnable', callStack: new CallStack()};
    thread.callStack.push(frame); j.threads = [thread]; j.currentThreadIndex = 0;
    const result = w.execute(frame, thread, compiled.state, 0);
    return {frame, thread, result};
  };
  const calls = () => j.classes.ExplicitMonitors.staticFields.get('calls:I');
  const lock = {type: 'java/lang/Object', fields: {}};
  const normal = invoke(caller, lock, new Int32Array([33]));
  t.ok(normal.result.returned, 'nested synchronized block completes in Wasm');
  t.equal(normal.result.value, 42, 'caller operand under invocation survives');
  t.equal(calls(), 1, 'effect executes once');
  t.equal(lock.lockCount, 0, 'normal path releases the monitor');
  t.equal(w.activeThread, null, 'ambient thread is restored');
  j.jit.monitorEnter(lock, {id: 7});
  const reentrant = invoke(read, lock, new Int32Array([12]));
  t.equal(reentrant.result.value, 12, 'reentrant entry executes');
  t.equal(lock.lockCount, 1, 'reentrant exit retains outer acquisition');
  j.jit.monitorExit(lock, {id: 7});

  j.jit.monitorEnter(lock, {id: 99});
  const before = calls(), blocked = invoke(caller, lock, new Int32Array([33]));
  t.notOk(blocked.result.returned, 'contended nested call parks');
  t.equal(blocked.thread.status, 'BLOCKED', 'thread blocks on the monitor');
  t.equal(blocked.thread.blockingOn, lock, 'blocking target is retained');
  t.equal(calls(), before, 'contended entry has no effects');
  const child = blocked.thread.callStack.peek();
  t.equal(child.method.name, 'read', 'canonical callee is parked');
  t.equal(child.instructions[child.pc].instruction, 'monitorenter', 'continuation retries monitor entry');
  t.equal(child.stack.peek(), lock, 'original monitor operand survives');
  t.equal(lock.lockOwner, 99, 'contention preserves other owner');
  j.jit.monitorExit(lock, {id: 99}); blocked.thread.status = 'runnable';
  let steps = 0, returned;
  while (!blocked.thread.callStack.isEmpty() && ++steps < 100) {
    const f = blocked.thread.callStack.peek(), ins = f.instructions[f.pc++].instruction;
    if ((typeof ins === 'string' ? ins : ins?.op) === 'ireturn') returned = f.stack.peek();
    if (ins) await j.executeInstruction(ins, f, blocked.thread);
  }
  t.ok(steps < 100, 'continuation completes');
  t.equal(returned, 42, 'resumption preserves caller operand and result');
  t.equal(calls(), before + 1, 'resumption does not replay effects');
  t.equal(lock.lockCount, 0, 'resumption releases acquired monitor');

  const failed = invoke(caller, lock, null);
  t.notOk(failed.result.returned, 'throw parks cleanup handler');
  t.equal(lock.lockOwner, 7, 'handler retains lock until explicit exit');
  steps = 0; let thrown;
  try {
    while (!failed.thread.callStack.isEmpty() && ++steps < 100) {
      const f = failed.thread.callStack.peek(), ins = f.instructions[f.pc++].instruction;
      if (ins) await j.executeInstruction(ins, f, failed.thread);
    }
  } catch (error) { thrown = error; }
  t.equal(thrown?.type, 'java/lang/NullPointerException', 'original exception propagates');
  t.equal(lock.lockCount, 0, 'exceptional cleanup releases monitor');
  t.equal(calls(), before + 2, 'throwing body executes exactly once');
  t.end();
});

test('explicit monitor continuation preserves operands beneath the lock', async t => {
  const j = new JVM({jit: {compileWorker: false, wasmStructured: true}}), w = j.jit.wasmJit;
  const method = {name: 'under', descriptor: '(Ljava/lang/Object;)I', flags: ['static'],
    attributes: [{type: 'code', code: {localsSize: 1, stackSize: 2, exceptionTable: [],
      codeItems: ['iconst_5', 'aload_0', 'monitorenter', 'aload_0', 'monitorexit', 'ireturn']
        .map((instruction, pc) => ({instruction, pc, labelDef: `L${pc}:`}))}}]};
  const state = w.methodState({method}); w.compile({method, className: 'MonitorOperands'}, state, {asCallee: true});
  t.equal(state.status, 'ready', 'synthetic valid stack shape compiles');
  t.ok(state.meta.fullyCompiled, 'normal instructions have complete coverage');
  t.equal(state.meta.deoptableCalls, 2, 'complete coverage does not authorize frame-free calls');
  const lock = {type: 'java/lang/Object'}, frame = new Frame(method);
  frame.className = 'MonitorOperands'; frame.locals[0] = lock;
  const thread = {id: 7, status: 'runnable', callStack: new CallStack()}; thread.callStack.push(frame);
  j.jit.monitorEnter(lock, {id: 99});
  w.execute(frame, thread, state, 0);
  t.equal(frame.pc, 2, 'exit points to monitorenter');
  t.deepEqual(frame.stack.items, [5, lock], 'both underlying value and lock are materialized');
  j.jit.monitorExit(lock, {id: 99}); thread.status = 'runnable';
  for (let i = 0; i < 3; i++) {
    const ins = frame.instructions[frame.pc++].instruction;
    await j.executeInstruction(ins, frame, thread);
  }
  t.equal(frame.stack.peek(), 5, 'underlying result remains after acquire and release');
  t.equal(lock.lockCount, 0, 'interpreter continuation releases the lock');
  thread.callStack.pop();
  const absent = new Frame(method); absent.locals[0] = lock;
  state.meta.box.frame = absent;
  const args = state.meta.paramSlots.map(({slot}) => absent.locals[slot] ?? 0);
  t.equal(state.run(...args, 0, 10000), 2, 'missing ambient thread exits before acquiring');
  t.equal(lock.lockCount, 0, 'missing ambient thread does not acquire a lock');
  t.deepEqual(absent.stack.items, [5, lock], 'missing thread preserves canonical operands');
  state.meta.box.frame = null;
  const nullFrame = new Frame(method); nullFrame.locals[0] = null;
  thread.callStack.push(nullFrame);
  t.throws(() => w.execute(nullFrame, thread, state, 0),
    error => error.type === 'java/lang/NullPointerException', 'null monitor raises the guest exception');
  t.end();
});

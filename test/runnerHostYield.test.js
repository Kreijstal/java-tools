'use strict';
const test = require('tape');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');

function activation(instructions) {
  const method = {name: 'work', descriptor: '()I', flags: ['static'],
    attributes: [{type: 'code', code: {
      codeItems: instructions.map(instruction => ({instruction})),
      localsSize: '1', stackSize: '2', exceptionTable: [],
    }}]};
  const frame = new Frame(method);
  const callStack = new Stack();
  callStack.push(frame);
  return {frame, thread: {status: 'runnable', callStack}};
}

test('warm baseline static accesses finish without per-bytecode promise turns', async t => {
  const {makeJavaFixtureCompiler} = require('./javaFixture');
  const compile = makeJavaFixtureCompiler('runner-warm-statics-');
  const classpath = compile(t, 'WarmStatics', `
public class WarmStatics {
  static int value;
  static int touch() { value = 42; return value; }
}`);
  const jvm = new JVM({classpath, jit: {compileWorker: false}});
  await jvm.loadClassByName('WarmStatics');
  jvm.classInitializationState.set('WarmStatics', 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy('WarmStatics', 'touch', '()I');
  const frame = new Frame(method);
  frame.className = 'WarmStatics';
  const thread = {id: 0, status: 'runnable', callStack: new Stack()};
  thread.callStack.push(frame);
  jvm._nextEventLoopYieldAt = Infinity;
  const completion = jvm.jit.runFrame(frame, thread);
  t.equal(thread.callStack.items.length, 0, 'warm get/put complete before yielding to microtasks');
  t.equal((await completion).value, 42, 'read observes the preceding write');
  t.equal(jvm.classes.WarmStatics.staticFields.get('value:I'), 42, 'static write is retained');
  t.end();
});

test('cold baseline static accesses still await initialization and preserve retry operands', async t => {
  for (const op of ['getstatic', 'putstatic']) {
    const jvm = new JVM({jit: {compileWorker: false}});
    const prefix = op === 'putstatic' ? ['iconst_5', 'iconst_2'] : ['iconst_5'];
    const {frame, thread} = activation([...prefix,
      {op, arg: ['Field', 'ColdOwner', ['value', 'I']]}, 'ireturn']);
    jvm._nextEventLoopYieldAt = Infinity;
    let finishInitialization;
    jvm.initializeClassIfNeeded = () => new Promise(resolve => { finishInitialization = resolve; });
    const completion = jvm.jit.runFrame(frame, thread);
    t.equal(typeof finishInitialization, 'function', `${op} reaches the asynchronous initializer`);
    t.equal(thread.callStack.peek(), frame, `${op} retains the pending activation`);
    finishInitialization(true); // An initializer frame was pushed; retry the bytecode later.
    const result = await completion;
    t.ok(result.deopt && result.transient, `${op} hands initialization back to the scheduler`);
    t.equal(frame.pc, prefix.length, `${op} retains the original bytecode PC`);
    t.deepEqual(frame.stack.items, op === 'putstatic' ? [5, 2] : [5],
      `${op} preserves operands for exactly-once retry`);
  }
  t.end();
});

test('short baseline entries service an expired host deadline before executing', async t => {
  const jvm = new JVM({jit: {compileWorker: false}});
  const {frame, thread} = activation(['iconst_5', 'ireturn']);
  jvm._nextEventLoopYieldAt = 0;
  let serviced = false;
  setImmediate(() => {
    serviced = true;
    t.equal(frame.pc, 0, 'yield preserves the next instruction');
    t.equal(frame.stack.items.length, 0, 'no guest effect occurs before resumption');
    t.equal(thread.callStack.peek(), frame, 'activation remains owned by the runner');
  });
  const result = await jvm.jit.runFrame(frame, thread);
  t.ok(serviced, 'host delivery runs before even a short method completes');
  t.equal(result.value, 5, 'guest result survives the host turn');
  t.equal(thread.callStack.items.length, 0, 'activation returns exactly once');
  t.ok(jvm._nextEventLoopYieldAt > 0, 'shared deadline is renewed');
  t.end();
});

test('a long baseline body checks the deadline again after entry', async t => {
  const jvm = new JVM({jit: {compileWorker: false}});
  const {frame, thread} = activation(['iconst_5', ...Array.from({length: 512}, () => ['dup', 'pop']).flat(), 'ireturn']);
  jvm._nextEventLoopYieldAt = Infinity;
  // Expire the deadline after guest execution has begun, without relying on
  // machine speed or changing the global clock used by the test runner.
  Object.defineProperty(frame.instructions[10], 'instruction', {get() {
    jvm._nextEventLoopYieldAt = 0;
    return 'pop';
  }});
  let serviced = false;
  setImmediate(() => {
    serviced = true;
    t.ok(frame.pc > 10 && frame.pc < 1025, 'host runs before the body finishes');
    t.ok(frame.stack.items.length > 0 && frame.stack.items.every(value => value === 5), 'materialized operands survive the yield');
  });
  const result = await jvm.jit.runFrame(frame, thread);
  t.ok(serviced, 'long body services host delivery');
  t.equal(result.value, 5, 'long body resumes with the same result');
  t.end();
});

test('a nested baseline quantum returns to the scheduler without replaying the call', async t => {
  const {makeJavaFixtureCompiler} = require('./javaFixture');
  const compile = makeJavaFixtureCompiler('runner-scheduler-yield-');
  const classpath = compile(t, 'RunnerYieldFixture', `
public class RunnerYieldFixture {
  static int calls, result;
  static int child() { calls++; return 5; }
  public static void drive() { result = 17 + child(); }
}`);
  const jvm = new JVM({classpath, jit: {compileWorker: false, warmupThreshold: 0}});
  await jvm.loadClassByName('RunnerYieldFixture');
  jvm.classInitializationState.set('RunnerYieldFixture', 'INITIALIZED');
  jvm.classes.RunnerYieldFixture.staticFields.set('calls:I', 0);
  jvm.classes.RunnerYieldFixture.staticFields.set('result:I', 0);
  const jit = jvm.jit;
  jit.wasmJit.enabled = false;
  jit.getGeneratedFunction = () => null; // Exercise the baseline call chain.
  const method = await jvm.findMethodInHierarchy('RunnerYieldFixture', 'drive', '()V');
  const root = new Frame(method);
  root.className = 'RunnerYieldFixture';
  const thread = {id: 0, status: 'runnable', callStack: new Stack(), pendingException: null};
  thread.callStack.push(root);
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  jvm._nextEventLoopYieldAt = Infinity;
  const runFrame = jit.runFrame;
  let expired = false;
  jit.runFrame = function(frame, scheduled) {
    if (frame.method.name === 'child' && !expired) {
      expired = true;
      jvm._nextEventLoopYieldAt = 0;
    }
    return runFrame.call(this, frame, scheduled);
  };
  await jit.tryRunFrame(root, thread);
  t.ok(expired, 'real nested invocation reaches the baseline runner');
  t.equal(thread.callStack.items.length, 2, 'scheduler receives both live activations');
  t.equal(thread.callStack.peek().method.name, 'child', 'child owns the next bytecode');
  t.deepEqual(root.stack.items, [17], 'caller retains the operand below the invocation');
  t.notOk(jit.runningFrames.has(root), 'host continuation released scheduler ownership');
  t.notOk(jit.deoptedMethods.has(method), 'yield does not permanently deoptimize the caller');
  let ticks = 0;
  while (!thread.callStack.isEmpty() && ticks++ < 1000) await jvm.executeTick();
  t.ok(thread.callStack.isEmpty(), 'scheduler resumes and completes both activations');
  const fields = jvm.classes.RunnerYieldFixture.staticFields;
  t.equal(fields.get('calls:I'), 1, 'callee side effect occurs exactly once');
  t.equal(fields.get('result:I'), 22, 'caller receives the child result exactly once');
  t.end();
});

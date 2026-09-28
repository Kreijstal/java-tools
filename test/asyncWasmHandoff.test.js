const test = require('tape');
const {JVM} = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const compileFixture = makeJavaFixtureCompiler('async-wasm-handoff-');

test('asynchronous calls yield after a partial Wasm exit', async t => {
  const classpath = compileFixture(t, 'HandoffProbe', `
public class HandoffProbe { static int work() { return 7; } }
`);
  const jvm = new JVM({classpath, jit: {compileWorker: false}});
  const data = await jvm.loadClassByName('HandoffProbe');
  jvm.classInitializationState.set('HandoffProbe', 'INITIALIZED');
  const method = jvm.findMethod(data, 'work', '()I');
  const parent = new Frame(method); parent.className = 'HandoffProbe';
  const pending = new Frame(method); pending.className = 'PendingChild';
  const thread = {id: 1, status: 'runnable', callStack: new Stack()};
  thread.callStack.push(parent);
  jvm.jit.isSupported = () => true;
  jvm.jit.isImportedArrayJsClosurePreferred = () => false;
  jvm.jit.hasPreparedFullWasmUpgrade = () => false;
  jvm.jit.wasmJit.enabled = true;
  jvm.jit.wasmJit.runNested = (child, activeThread) => {
    child.pc = 1;
    activeThread.callStack.push(pending);
    return {exited: true, deopted: false};
  };
  let fallbackCalls = 0;
  jvm.jit.getGeneratedFunction = () => null;
  jvm.jit.runFrame = async () => {fallbackCalls++; return {returned: true, value: 7};};
  const result = await jvm.jit.invoke('invokestatic', parent,
    {arg: ['Method', 'HandoffProbe', ['work', '()I']]}, thread, 0);
  t.ok(result?.deopt && result.transient, 'the scheduler owns the continuation after the exit');
  t.equal(fallbackCalls, 0, 'no caller fallback runs above a pending descendant');
  t.equal(thread.callStack.peek(), pending, 'the pending descendant remains authoritative');
  t.end();
});

const test = require('tape');
const {JVM} = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const compileFixture = makeJavaFixtureCompiler('jit-native-resolution-');

test('asynchronous JIT resolution preserves guest constructors and overrides', async t => {
  const classpath = compileFixture(t, 'NativeResolutionProbe', `
public class NativeResolutionProbe {
  byte[] data;
  NativeResolutionProbe() { data = new byte[32]; }
  public String toString() { return "guest override"; }
}`);
  const jvm = new JVM({classpath, jit: {compileWorker: false}});
  await jvm.loadClassByName('NativeResolutionProbe');
  t.equal(await jvm.jit.findJreMethod('NativeResolutionProbe', 'NativeResolutionProbe', '<init>', '()V'),
    null, 'a guest constructor is not replaced by Object.<init>');
  t.equal(await jvm.jit.findJreMethod('NativeResolutionProbe', 'java/lang/Object', 'toString', '()Ljava/lang/String;'),
    null, 'the runtime guest override beats the declared Object method');
  t.equal(typeof await jvm.jit.findJreMethod('NativeResolutionProbe', 'java/lang/Object', 'hashCode', '()I'),
    'function', 'an inherited Object method remains available');
  t.equal(typeof await jvm.jit.findJreMethod('[I', 'java/lang/Object', 'clone', '()Ljava/lang/Object;'),
    'function', 'array Object methods remain available');
  t.equal(jvm.jit.resolveSynchronousJreMethod('NativeResolutionProbe', 'java/lang/Object', 'toString', '()Ljava/lang/String;'),
    null, 'synchronous dispatch also preserves the guest override');
  t.equal(typeof jvm.jit.resolveSynchronousJreMethod('[I', 'java/lang/Object', 'clone', '()Ljava/lang/Object;'),
    'function', 'synchronous array clone remains available');
  const method = jvm.findMethod(jvm.classes.NativeResolutionProbe, 'toString', '()Ljava/lang/String;');
  const parent = new Frame(method);
  parent.stack.push({type: 'NativeResolutionProbe', fields: {}});
  const thread = {id: 1, status: 'runnable', callStack: new Stack()};
  thread.callStack.push(parent);
  jvm.jit.wasmJit.enabled = false;
  jvm.jit.isSupported = () => false;
  jvm.jit.isShortSupportedHelper = () => false;
  jvm.jit.prefersWholeMethodJs = () => false;
  const handoff = await jvm.jit.invoke('invokevirtual', parent, {
    arg: [null, 'java/lang/Object', ['toString', '()Ljava/lang/String;']],
  }, thread, 0);
  t.ok(handoff.deopt && handoff.transient, 'an Object-declared call yields to its guest override');
  t.equal(thread.callStack.peek().method, method, 'the guest override is the pending child frame');
  t.end();
});

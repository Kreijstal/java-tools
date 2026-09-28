'use strict';

const test = require('tape');
const { makeJavaFixtureCompiler } = require('./javaFixture');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const CallStack = require('../src/core/callStack');

const fixture = makeJavaFixtureCompiler('wasm-return-retention-');
for (const structured of [false, true]) {
  test(`reference return scratch is released (structured=${structured})`, async t => {
    const previousInline = process.env.JVM_WASM_INLINE;
    process.env.JVM_WASM_INLINE = '0';
    t.teardown(() => {
      if (previousInline === undefined) delete process.env.JVM_WASM_INLINE;
      else process.env.JVM_WASM_INLINE = previousInline;
    });
    const classpath = fixture(t, 'ReferenceReturn', `public class ReferenceReturn {
      public static int[] identity(int[] a) { return a; }
      public static int lengths(int[] a, int[] b) {
        int[] x = identity(a);
        int[] y = identity(b);
        return x.length + y.length;
      }
    }`);
    const jvm = new JVM({ classpath, jit: { compileWorker: false, wasmStructured: structured } });
    await jvm.preloadClasspathClasses();
    jvm.classInitializationState.set('ReferenceReturn', 'INITIALIZED');
    const wasm = jvm.jit.wasmJit;
    wasm.enabled = true;
    const compile = async (name, descriptor) => {
      const method = await jvm.findMethodInHierarchy('ReferenceReturn', name, descriptor);
      const state = wasm.methodState({ method });
      wasm.compile({ method, className: 'ReferenceReturn' }, state, { asCallee: true });
      t.equal(state.status, 'ready', name + ' compiles');
      return { method, state };
    };
    const invoke = (compiled, args) => {
      const frame = new Frame(compiled.method);
      frame.className = 'ReferenceReturn';
      args.forEach((value, index) => { frame.locals[index] = value; });
      const thread = { id: 7, status: 'runnable', callStack: new CallStack() };
      thread.callStack.push(frame);
      return wasm.runNested(frame, thread);
    };
    const id = await compile('identity', '([I)[I');
    const array = new Int32Array(1024 * 1024);
    const result = invoke(id, [array]);
    // Boolean assertions avoid dumping the large array if this regresses.
    t.ok(result.value === array, 'canonical entry preserves reference identity');
    t.ok(id.state.meta.box.ret === undefined, 'JS result scratch does not retain the returned array');
    t.ok(id.state.meta.retv.value === null, 'Wasm result scratch does not retain the returned array');
    t.equal(invoke(id, [null]).value, null, 'null is a valid returned reference');

    const raw = id.state.meta.runv(array);
    t.equal(raw[0], -1, 'direct export returns normally');
    t.ok(raw[1] === array, 'direct export returns the exact reference');
    t.ok(id.state.meta.box.ret === undefined, 'direct export does not retain the JS scratch');
    t.ok(id.state.meta.retv.value === null, 'direct export clears its Wasm scratch');

    const lengths = await compile('lengths', '([I[I)I');
    if (structured) {
      t.ok(lengths.state.meta.directStaticLinks > 0,
        'reference returns cross a direct Wasm link without inlining');
    }
    t.equal(invoke(lengths, [new Int32Array(4), new Int32Array(6)]).value, 10,
      'linked calls keep both live returned references');
    t.ok(id.state.meta.box.ret === undefined, 'linked caller does not leave a JS reference');
    t.ok(id.state.meta.retv.value === null, 'linked caller does not leave a Wasm reference');
    t.end();
  });
}

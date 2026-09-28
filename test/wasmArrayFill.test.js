'use strict';
const test = require('tape');
const {JVM} = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const CallStack = require('../src/core/callStack');
const {supportsWasmTryTable} = require('../src/jit/wasmShared');
const fixture = require('./javaFixture').makeJavaFixtureCompiler('wasm-range-fill-');

for (const structured of [false, true]) {
  test(`Wasm range fill preserves initialization, mutation and exceptions (structured=${structured})`, async t => {
    const classpath = fixture(t, 'WasmRangeFill', `public class WasmRangeFill {
      static int fill(int[] a, int from, int to, int value) {
        int before = a[0]; java.util.Arrays.fill(a, from, to, value); return before + a[0];
      }
      static int drive(int[] a, int n) {
        int sum = 0; for (int i=0; i<n; i++) sum += fill(a, 0, 4, i); return sum;
      }
      static int caught(int[] a, int from, int to) {
        try { java.util.Arrays.fill(a, from, to, 7); return 1; }
        catch (RuntimeException e) { return -3; }
      }
    }`);
    const j = new JVM({classpath, wasmHeap: true, wasmHeapMb: 1,
      jit: {compileWorker: false, wasmStructured: structured}});
    await j.preloadClasspathClasses();
    j._setClassInitializationState('WasmRangeFill', 'INITIALIZED');
    const w = j.jit.wasmJit;
    const compile = async (name, descriptor) => {
      const method = await j.findMethodInHierarchy('WasmRangeFill', name, descriptor);
      const state = w.methodState({method});
      w.compile({method, className: 'WasmRangeFill'}, state, {asCallee: true});
      t.equal(state.status, 'ready', name + ' compiles');
      return {method, state};
    };
    const invoke = (compiled, args) => {
      const frame = new Frame(compiled.method); frame.className = 'WasmRangeFill';
      args.forEach((value, i) => frame.locals[i] = value);
      const thread = {id: 1, status: 'runnable', callStack: new CallStack()};
      thread.callStack.push(frame); j.threads = [thread]; j.currentThreadIndex = 0;
      const result = w.execute(frame, thread, compiled.state, 0);
      return {frame, thread, result};
    };
    j.classInitializationState.delete('java/util/Arrays');
    const fill = await compile('fill', '([IIII)I');
    t.ok(fill.state.meta.normalFlowFullyCompiled, 'range fill has compiled coverage');
    const values = new Int32Array([10, 20, 30, 40, 99]);
    const cold = invoke(fill, [values, 0, 4, 0]);
    t.notOk(cold.result.returned, 'cold owner falls back before effects');
    t.equal(cold.frame.pc, 0, 'initialization fallback preserves block entry');
    t.deepEqual([...values], [10, 20, 30, 40, 99], 'cold call changes no elements');
    j._setClassInitializationState('java/util/Arrays', 'INITIALIZED');
    for (const array of [Array.from(values), values, j.wasmHeap.alloc('[I', 5)]) {
      array.fill(99); array[0] = 10;
      const warm = invoke(fill, [array, 0, 4, -7]);
      t.ok(warm.result.returned, 'same module completes without a continuation');
      t.equal(warm.result.value, 3, 'post-fill load observes the new value');
      t.deepEqual([...array], [-7, -7, -7, -7, 99], 'range is exact and tail untouched');
    }
    for (const [from, to, type] of [[3, 2, 'IllegalArgumentException'],
      [-1, -2, 'IllegalArgumentException'], [-1, 3, 'ArrayIndexOutOfBoundsException'],
      [0, 6, 'ArrayIndexOutOfBoundsException'], [6, 6, 'ArrayIndexOutOfBoundsException']]) {
      const array = new Int32Array([10, 20, 30, 40, 99]);
      t.throws(() => invoke(fill, [array, from, to, 0]), error => error.type === 'java/lang/' + type,
        'compiled call preserves range-check precedence');
      t.deepEqual([...array], [10, 20, 30, 40, 99], 'failed validation makes no writes');
    }
    const drive = await compile('drive', '([II)I');
    const array = new Int32Array([10, 20, 30, 40, 99]);
    const driven = invoke(drive, [array, 4]);
    t.ok(driven.result.returned, 'nested bulk helper stays in compiled execution');
    t.equal(driven.result.value, 19, 'loop observes each mutation exactly once');
    t.equal(array[4], 99, 'nested loop preserves sentinel');
    if (supportsWasmTryTable()) {
      const caught = await compile('caught', '([III)I');
      for (const [array, from, to] of [[null, 5, -1], [new Int32Array(4), 3, 2]]) {
        const run = invoke(caught, [array, from, to]);
        let steps = 0, returned = run.result.value;
        while (!run.thread.callStack.isEmpty() && ++steps < 40) {
          const f = run.thread.callStack.peek(), ins = f.instructions[f.pc++].instruction;
          if ((typeof ins === 'string' ? ins : ins?.op) === 'ireturn') returned = f.stack.peek();
          if (ins) await j.executeInstruction(ins, f, run.thread);
        }
        t.ok(steps < 40, 'exception continuation finishes');
        t.equal(returned, -3, 'native throw reaches the original guest handler');
      }
    }
    t.end();
  });
}

test('range-fill bridge admits only the tested static signature', t => {
  const {addArrayFillImport} = require('../src/jit/wasmRuntimeImports');
  const registry = {addImport() {throw new Error('unexpected import');}};
  for (const [owner, name, descriptor] of [['GuestArrays', 'fill', '([IIII)V'],
    ['java/util/Arrays', 'fill', '([II)V'], ['java/util/Arrays', 'sort', '([I)V']]) {
    t.equal(addArrayFillImport(registry, {}, {arg: ['Method', owner, [name, descriptor]]}), null);
  }
  t.end();
});

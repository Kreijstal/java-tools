'use strict';
const test = require('tape');
const {JVM} = require('../src/core/jvm');
const Compiler = require('../src/jit/StructuredWasmCompiler');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const compile = makeJavaFixtureCompiler('wasm-complete-callee-');

test('required void callee chooses complete lowering over an inline guard exit', async t => {
  const classpath = compile(t, 'CompleteCallee', `
public class CompleteCallee {
  int calls;
  int value(int index) { calls++; return 3 + index; }
  static void fill(CompleteCallee voice, int[] values) {
    for (int i = 0; i < values.length; i++) values[i] = voice.value(i);
  }
  static int[] drive(CompleteCallee voice, int[] values) {
    fill(voice, values); return values;
  }
  public static void main(String[] args) {
    CompleteCallee voice = new CompleteCallee();
    int[] values = drive(voice, new int[4]);
    System.out.println(values[3]); System.out.println(voice.calls);
    try { drive(null, new int[1]); }
    catch (NullPointerException expected) { System.out.println(99); }
  }
}`);
  const j = new JVM({classpath, prepareBeforeMain: false, jit: {
    compileWorker: false, wasmStructured: true, retainCompilerDiagnostics: false,
  }});
  await j.preloadClasspathClasses();
  j._setClassInitializationState('CompleteCallee', 'INITIALIZED');
  const method = await j.findMethodInHierarchy('CompleteCallee', 'fill', '(LCompleteCallee;[I)V');
  const wasm = j.jit.wasmJit;
  const control = new Compiler(j, method, 'CompleteCallee', wasm).translateWith(true);
  t.ok(control.deoptStubCount > 0, 'control exercises an inline guard exit');
  t.notOk(control.normalFlowFullyCompiled, 'ordinary inline control is not complete');
  const state = wasm.methodState({method});
  wasm.compile({method, className: 'CompleteCallee'}, state, {asCallee: true});
  t.equal(state.status, 'ready', state.lastCompileError || 'required callee compiles');
  t.ok(state.meta?.fullyCompiled, 'required callee has complete coverage');
  t.equal(state.meta?.deoptStubCount, 0, 'selection removes the inline exit instead of relabelling it');
  const caller = await j.findMethodInHierarchy('CompleteCallee', 'drive', '(LCompleteCallee;[I)[I');
  const callerState = wasm.methodState({method: caller});
  wasm.compile({method: caller, className: 'CompleteCallee'}, callerState, {asCallee: true});
  t.ok(callerState.meta?.fullyCompiled, 'reference-returning caller can link the complete void helper');
  j.jre = {...j.jre, 'java/io/PrintStream': {...j.jre['java/io/PrintStream'],
    methods: {...j.jre['java/io/PrintStream'].methods}}};
  const output = [];
  j.registerJreMethods({'java/io/PrintStream': {'println(I)V': (_j, _o, args) => output.push(args[0])}});
  await j.run('CompleteCallee');
  t.deepEqual(output, [6, 4, 99], 'values, exactly-once side effects and null-receiver exception survive');
  t.end();
});

for (const isStatic of [true, false]) {
test(`${isStatic ? 'static' : 'instance'} callee lookup refreshes only after its dependency is ready`, async t => {
  const savedInline = process.env.JVM_WASM_INLINE;
  process.env.JVM_WASM_INLINE = '0';
  t.teardown(() => {
    if (savedInline === undefined) delete process.env.JVM_WASM_INLINE;
    else process.env.JVM_WASM_INLINE = savedInline;
  });
  const classpath = compile(t, 'PendingCallee', `
public class PendingCallee {
  int leaf(int value) { return value + 1; }
  ${isStatic ? 'static ' : ''}int work(PendingCallee self, int count) {
    int sum = 0;
    for (int i = 0; i < count; i++) sum += self.leaf(i);
    return sum;
  }
}`);
  const j = new JVM({classpath, jit: {compileWorker: false, wasmStructured: true}});
  await j.preloadClasspathClasses();
  j._setClassInitializationState('PendingCallee', 'INITIALIZED');
  const method = await j.findMethodInHierarchy('PendingCallee', 'work', '(LPendingCallee;I)I');
  const leaf = await j.findMethodInHierarchy('PendingCallee', 'leaf', '(I)I');
  const w = j.jit.wasmJit;
  w.noOnDemandCalleeCompile = true;
  const state = w.methodState({method});
  w.compile({method, className: 'PendingCallee'}, state, {asCallee: true});
  t.equal(state.status, 'ready', 'a real partial module is published');
  t.ok(state.partialDeps, 'partial module records the unavailable dependency');
  t.notOk(state.meta?.fullyCompiled, 'initial module is incomplete');
  const old = state.meta;
  const get = () => isStatic
    ? w.findReadyStatic('PendingCallee', 'work', '(LPendingCallee;I)I')
    : w.findReadyInstance('PendingCallee', 'work', '(LPendingCallee;I)I');
  get();
  t.equal(state.meta, old, 'unmoved dependencies do not rebuild');
  const leafState = w.methodState({method: leaf});
  w.compile({method: leaf, className: 'PendingCallee'}, leafState, {asCallee: true});
  t.ok(leafState.meta?.fullyCompiled, 'dependency becomes complete');
  get();
  t.equal(state.meta, old, 'disabled on-demand compilation preserves the old body');
  w.noOnDemandCalleeCompile = false;
  w.compilationFrozen = true;
  get();
  t.equal(state.meta, old, 'frozen compilation preserves the old body');
  w.compilationFrozen = false;
  j.guestStarted = true;
  w.refusePostMainCompiles = true;
  get();
  t.equal(state.meta, old, 'post-main enforcement preserves the old body');
  j.guestStarted = false;
  w.refusePostMainCompiles = false;
  const budget = w.onDemandCalleeBudgetAvailable;
  w.onDemandCalleeBudgetAvailable = () => false;
  get();
  t.equal(state.meta, old, 'exhausted compilation budget preserves the old body');
  w.onDemandCalleeBudgetAvailable = budget;
  t.ok(get()?.meta?.fullyCompiled, 'callee lookup rebuilds after the dependency becomes ready');
  t.equal(state.depRecompiles, 1, 'dependency transition triggers one bounded refresh');
  get();
  t.equal(state.depRecompiles, 1, 'stable dependency does not rebuild again');
  t.end();
});
}

// Exclusive compile-phase accounting, and the analyses it exposed as repeated.
//
// The Start Game census reported ~8 s of post-main synchronous compilation
// inside a transition whose click-to-first-frame freeze was ~4-5 s. Two
// explanations were possible: the counter double-counting nested compiles, or
// compilation continuing past the first frame. These tests pin the properties
// the answer rests on -- that a phase is never charged for the phases nested
// inside it, that a compile triggered from inside another compile is its own
// phase, and that each outermost compile carries its own start so a transition
// can be cut at its first frame.
const test = require('tape');
const { JVM } = require('../src/core/jvm');

const spin = (ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* burn */ }
};

test('a phase is not charged for the phases nested inside it', (t) => {
  const jvm = new JVM({ classpath: [],
    jit: { compileWorker: false, compilePhaseTiming: true } });
  const jit = jvm.jit;
  jit.compilePhase("outer", () => {
    spin(12);
    jit.compilePhase("inner", () => spin(25));
    spin(12);
  });
  const { phases } = jit.compilePhaseCensus();
  t.ok(phases.inner.exclusiveMs >= 20, 'the inner phase keeps its own time');
  t.ok(phases.outer.exclusiveMs >= 15,
    'the outer phase keeps the time it spent itself');
  t.ok(phases.outer.exclusiveMs < phases.inner.exclusiveMs,
    'and not the time its child spent');
  t.ok(phases.outer.inclusiveMs >= phases.outer.exclusiveMs +
    phases.inner.exclusiveMs - 5,
  'the inclusive figure is the interval the phase spanned');
  t.end();
});

test('a phase closes even when the work inside it throws', (t) => {
  const jvm = new JVM({ classpath: [],
    jit: { compileWorker: false, compilePhaseTiming: true } });
  const jit = jvm.jit;
  t.throws(() => jit.compilePhase("thrower", () => { throw new Error("x"); }),
    /x/, 'the error is not swallowed');
  t.equal(jit.compilePhaseStack.length, 0, 'and the stack is not left suspended');
  jit.compilePhase("after", () => spin(2));
  t.equal(jit.compilePhaseCensus().phases.after.count, 1,
    'so the next phase is accounted normally');
  t.end();
});

test('the facility costs nothing when it is off', (t) => {
  const jvm = new JVM({ classpath: [], jit: { compileWorker: false } });
  const jit = jvm.jit;
  t.equal(jit.compilePhaseTiming, false, 'off unless asked for');
  t.equal(jit.beginCompilePhase("x"), null, 'no phase is opened');
  t.equal(jit.compilePhase("x", () => 7), 7, 'the work still runs and returns');
  jit.countCompileWork("y", 3);
  t.deepEqual(jit.compilePhaseCensus(), { phases: {}, counters: {} },
    'and nothing is recorded');
  t.end();
});

test('a compile timeline row carries its own start and duration', (t) => {
  const jvm = new JVM({ classpath: [],
    jit: { compileWorker: false, compilePhaseTiming: true } });
  const jit = jvm.jit;
  jit.mainStarted = true;
  const method = { name: "m", descriptor: "()V", attributes: [] };
  const outer = jit.startSynchronousCompile(method, "test");
  spin(5);
  // A callee compiled from inside the first one: its time belongs to it, not
  // to the compile that triggered it.
  const nested = jit.startSynchronousCompile(method, "test-callee");
  spin(15);
  nested.finish("wasm");
  outer.finish("structured-ssa");
  const { phases } = jit.compilePhaseCensus();
  t.equal(phases["compile.total"].count, 1, 'one outermost compile');
  t.equal(phases["compile.calleeRecursive"].count, 1, 'one nested compile');
  t.ok(phases["compile.calleeRecursive"].exclusiveMs >= 10,
    'the nested compile keeps its own time');
  t.ok(phases["compile.total"].exclusiveMs <
    phases["compile.calleeRecursive"].exclusiveMs,
  'and the compile that triggered it is not charged for it again');
  t.equal(jit.compileTimeline.length, 1,
    'only the outermost compile is timelined');
  const row = jit.compileTimeline[0];
  // The outer compile spans both spins; assert comfortably under their sum so
  // the test states the property rather than the clock's rounding.
  t.ok(row.startMs > 0 && row.ms >= 15,
    'with a start and an elapsed time, so a window can be cut at a frame');
  t.equal(row.tier, "structured-ssa", 'and the tier it produced');
  t.end();
});

test('the operand-category SSA analysis is built once per body', (t) => {
  const jvm = new JVM({ classpath: [], jit: { compileWorker: false } });
  const jit = jvm.jit;
  // The renderer and both stack-depth computations ask for this analysis, and
  // their trigger conditions overlap; rebuilding it cost 85 ms of a 732 ms
  // qc.b(IZ)Z compile in Deko Bloko.
  let built = 0;
  const codeItems = [{ instruction: "iconst_0" }, { instruction: "return" }];
  const method = { name: "m", descriptor: "()V", attributes: [] };
  jit.ssaOperandCategoryCache = {
    store: new Map(),
    get(key) { return this.store.get(key); },
    set(key, value) { built += 1; this.store.set(key, value); },
  };
  const first = jit.ssaOperandCategories(codeItems, method);
  const second = jit.ssaOperandCategories(codeItems, method);
  t.equal(built, 1, 'the second ask does not rebuild');
  t.equal(second, first, 'and gets the same analysis back');
  const other = jit.ssaOperandCategories(
    [{ instruction: "return" }], method);
  t.equal(built, 2, 'a different body is a different analysis');
  t.notEqual(other, first, 'and is not confused with the first');
  t.end();
});

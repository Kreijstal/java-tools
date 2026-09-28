// The guest's compile-turn budget.
//
// A synchronous compile runs on the thread the guest runs on, so its duration
// is a freeze the player sees. Clicking Stamina Mode in Deko Bloko froze
// Firefox for 9.7-10.0 s, nearly all of it post-main synchronous compilation:
// two gameplay methods of 4121 and 3463 bytecodes were entered for the first
// time, and each dragged a recursive cascade of ~40 cold callees into its own
// compile turn.
//
// These tests pin the bound that ships: the deadline that stops a Wasm
// compile turn from pulling further cold callees into itself, and the
// parsing of the budget that arms it.
const test = require('tape');
const { JVM } = require('../src/core/jvm');

test('the budget only applies while the guest is running', (t) => {
  const jvm = new JVM({ classpath: [], jit: { compileWorker: false } });
  const jit = jvm.jit;
  t.equal(jit.postMainCompileBudgetMs, 120, 'default budget is 120 ms');
  jvm.guestStarted = false;
  t.equal(jit.guestCompileBudgetMs(), 0,
    'before the guest starts there is nothing to keep responsive');
  jvm.guestStarted = true;
  t.equal(jit.guestCompileBudgetMs(), 120, 'once it runs the bound is in force');
  t.end();
});

test('an unreadable budget falls back to the default, never to zero', (t) => {
  // The first version of this read the environment as
  // `typeof process !== "undefined" && process.env && process.env.NAME`,
  // which is `false` -- not `undefined` -- where there is no process at all.
  // `??` does not catch false, so `Number(false)` set the budget to 0 and
  // turned the bound off in every browser bundle, which is the only place it
  // was written for. Any non-number must land on the default instead.
  for (const bad of [NaN, undefined, '', 'nonsense', -1, false]) {
    const jvm = new JVM({ classpath: [],
      jit: { compileWorker: false, postMainCompileBudgetMs: bad } });
    t.equal(jvm.jit.postMainCompileBudgetMs, 120,
      `${String(bad)} falls back to the default budget`);
  }
  t.end();
});


test('a zero budget disables the bound entirely', (t) => {
  const jvm = new JVM({ classpath: [],
    jit: { compileWorker: false, postMainCompileBudgetMs: 0 } });
  jvm.guestStarted = true;
  t.equal(jvm.jit.guestCompileBudgetMs(), 0, 'no budget in force');
  t.end();
});

test('the Wasm callee cascade stops at the turn deadline', (t) => {
  const jvm = new JVM({ classpath: [], jit: { compileWorker: false } });
  const wasm = jvm.jit.wasmJit;
  t.ok(wasm.onDemandCalleeBudgetAvailable(),
    'outside a compile there is no deadline to exceed');
  wasm._calleeCompileDeadline = Infinity;
  t.ok(wasm.onDemandCalleeBudgetAvailable(), 'an unbounded turn never refuses');
  wasm._calleeCompileDeadline = -1;
  t.notOk(wasm.onDemandCalleeBudgetAvailable(),
    'a spent turn builds no further cold callees');
  t.equal(wasm.calleeCompileBudgetExhaustedCount, 1,
    'and says so, so a run can tell whether the bound ever bit');
  wasm._calleeCompileDeadline = undefined;
  t.ok(wasm.onDemandCalleeBudgetAvailable(), 'the next turn starts clean');
  t.end();
});

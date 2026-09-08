'use strict';

// docs/phase1-linked-call-abi.md 3: "codegen states the dependency; resolving
// it is the runtime's job."
//
// Phase 1 landed the first half -- `meta.linkBindings` records every callee a
// module still needs -- but nothing in src/ ever read it back, so `pending`
// meant "was unresolved when this was lowered" rather than "is unresolved".
// These tests pin the second half: a registry that knows which callers wait on
// which callee, a resolution step when that callee becomes ready, and a
// publication gate that refuses a module whose late-bound sites have all become
// provably dead.
//
// The last test is the one that matters for correctness rather than for
// bookkeeping: two mutually recursive methods must produce exactly the
// interpreter's answers. Neither can be linked to the other at codegen (each is
// 'compiling' while the other is lowered), which is the "recursive dependency
// group" the plan left open.

const test = require('tape');
const { makeJavaFixtureCompiler } = require('./javaFixture');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JVM } = require('../src/core/jvm');
const WasmJit = require('../src/jit/WasmJit');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');

const compileJavaFixture = makeJavaFixtureCompiler('pendinglink-fixture-');
function withEnv(t, vars) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.teardown(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

// A WasmJit with only the fields the registry touches. The registry is pure
// bookkeeping over states and metas, so driving a whole JVM to exercise it
// would test the compiler instead of the thing under test.
function bareJit(overrides = {}) {
  const jit = Object.create(WasmJit.prototype);
  jit.pendingLinkWaiters = new Map();
  jit.pendingLinkRelinks = 0;
  jit.pendingLinkResolved = 0;
  jit.relinkOnResolveLimit = 0;
  return Object.assign(jit, overrides);
}

// lateBound defaults to true because that is the interesting case: a binding
// whose site really was lowered as an lcall_ trampoline. A pending binding
// with lateBound false is the demoted-block case, covered explicitly below.
const binding = (key, className, name, descriptor, pending, lateBound = true) => ({
  kind: 'static', key, className, name, descriptor, pending, lateBound,
});

// ---------------------------------------------------------------------------
// 1. The registry reads linkBindings back
// ---------------------------------------------------------------------------

test('a caller with an unresolved binding is registered against that callee', (t) => {
  const jit = bareJit();
  const caller = { key: 'Caller.run()V', status: 'ready' };
  const meta = {
    linkBindings: [
      binding('Callee.slow(I)I', 'Callee', 'slow', '(I)I', true),
      binding('Callee.fast(I)I', 'Callee', 'fast', '(I)I', false),
    ],
  };

  const pending = jit.registerPendingLinks(caller, meta);

  t.equal(pending, 1, 'only the unresolved binding counts as pending');
  t.ok(jit.pendingLinkWaiters.has('Callee.slow(I)I'),
    'the unresolved callee has a waiter set');
  t.ok(jit.pendingLinkWaiters.get('Callee.slow(I)I').has(caller),
    'the caller is in it');
  t.notOk(jit.pendingLinkWaiters.has('Callee.fast(I)I'),
    'a binding that was already linked registers no waiter');
  t.end();
});

test('a demoted call site does not count as a waiting caller', (t) => {
  // Regression. staticCallImport records a binding for EVERY static call site,
  // pushing it before the incompatible check that demotes the block -- so a
  // refused callee leaves `pending: true` behind with no trampoline attached.
  // Counting those made the publication gate refuse a module that legitimately
  // compiles with that block demoted, which cost structuredWasm.test.js two
  // assertions.
  const jit = bareJit({ staticLinkClassification: () => 'incompatible' });
  const meta = {
    linkBindings: [
      binding('Gone.slow(I)I', 'Gone', 'slow', '(I)I', true, false),
    ],
  };
  t.equal(jit.registerPendingLinks({ key: 'C.run()V' }, meta), 0,
    'a demoted site registers no waiter');
  t.equal(jit.pendingLinkWaiters.size, 0, 'and nothing is recorded');
  t.equal(jit.pendingLinkVerdict(meta), null,
    'and it cannot make the module unpublishable');
  t.end();
});

test('a module with no bindings at all registers nothing', (t) => {
  const jit = bareJit();
  // Negative control: without this, a registry that indiscriminately recorded
  // every caller would pass every assertion above.
  t.equal(jit.registerPendingLinks({ key: 'A.b()V' }, { linkBindings: [] }), 0,
    'empty binding list is zero pending');
  t.equal(jit.registerPendingLinks({ key: 'A.b()V' }, {}), 0,
    'a meta with no linkBindings at all is zero pending');
  t.equal(jit.registerPendingLinks({ key: 'A.b()V' }, null), 0,
    'no meta is zero pending');
  t.equal(jit.pendingLinkWaiters.size, 0, 'and nothing was recorded');
  t.end();
});

// ---------------------------------------------------------------------------
// 2. Resolution
// ---------------------------------------------------------------------------

test('a callee becoming ready drains exactly its own waiters', (t) => {
  const jit = bareJit();
  const one = { key: 'One.run()V', status: 'ready' };
  const two = { key: 'Two.run()V', status: 'ready' };
  jit.registerPendingLinks(one,
    { linkBindings: [binding('Callee.slow(I)I', 'Callee', 'slow', '(I)I', true)] });
  jit.registerPendingLinks(two,
    { linkBindings: [binding('Callee.slow(I)I', 'Callee', 'slow', '(I)I', true)] });
  jit.registerPendingLinks(two,
    { linkBindings: [binding('Other.x(I)I', 'Other', 'x', '(I)I', true)] });

  const drained = jit.resolvePendingLinks({ key: 'Callee.slow(I)I' });

  t.equal(drained, 2, 'both callers waiting on that callee are resolved');
  t.equal(jit.pendingLinkResolved, 2, 'and counted');
  t.notOk(jit.pendingLinkWaiters.has('Callee.slow(I)I'), 'the waiter set is cleared');
  t.ok(jit.pendingLinkWaiters.has('Other.x(I)I'),
    'a different callee keeps its own waiters -- specificity control');
  t.equal(jit.resolvePendingLinks({ key: 'Nobody.waits()V' }), 0,
    'resolving a callee nobody waits on is a no-op');
  t.end();
});

test('re-linking is off by default and bounded when on', (t) => {
  const waiters = () => [
    { key: 'A.run()V', status: 'ready' },
    { key: 'B.run()V', status: 'ready' },
    { key: 'C.run()V', status: 'ready' },
  ];

  const off = bareJit();
  const offCallers = waiters();
  for (const c of offCallers) {
    off.registerPendingLinks(c,
      { linkBindings: [binding('X.y()V', 'X', 'y', '()V', true)] });
  }
  off.resolvePendingLinks({ key: 'X.y()V' });
  t.equal(off.pendingLinkRelinks, 0, 'default limit 0 re-links nothing');
  t.notOk(offCallers.some((c) => c.depRecompilePending),
    'and marks no caller for recompile');

  const on = bareJit({ relinkOnResolveLimit: 2 });
  const onCallers = waiters();
  for (const c of onCallers) {
    on.registerPendingLinks(c,
      { linkBindings: [binding('X.y()V', 'X', 'y', '()V', true)] });
  }
  on.resolvePendingLinks({ key: 'X.y()V' });
  t.equal(on.pendingLinkRelinks, 2,
    'the bound is honoured -- three waiters, limit two');
  t.equal(onCallers.filter((c) => c.depRecompilePending).length, 2,
    'exactly two callers were marked');
  t.end();
});

// ---------------------------------------------------------------------------
// 3. Publication gate
// ---------------------------------------------------------------------------

test('the publication gate separates dead links from live ones', (t) => {
  const classify = new Map([
    ['Dead.a()V', 'incompatible'],
    ['Dead.b()V', 'incompatible'],
    ['Live.c()V', 'unknown'],
  ]);
  const jit = bareJit({
    staticLinkClassification(className, name, descriptor) {
      return classify.get(`${className}.${name}${descriptor}`) || 'unknown';
    },
  });

  t.equal(jit.pendingLinkVerdict({ linkBindings: [] }), null,
    'no pending bindings is no verdict');
  t.equal(jit.pendingLinkVerdict(null), null, 'no meta is no verdict');

  const allDead = jit.pendingLinkVerdict({
    linkBindings: [
      binding('Dead.a()V', 'Dead', 'a', '()V', true),
      binding('Dead.b()V', 'Dead', 'b', '()V', true),
    ],
  });
  t.equal(allDead.pending, 2, 'both bindings are pending');
  t.equal(allDead.unresolvable, 2, 'and both are now provably dead');
  t.deepEqual(allDead.blockers, [], 'so there is nothing left to wait for');

  const mixed = jit.pendingLinkVerdict({
    linkBindings: [
      binding('Dead.a()V', 'Dead', 'a', '()V', true),
      binding('Live.c()V', 'Live', 'c', '()V', true),
    ],
  });
  t.equal(mixed.unresolvable, 1, 'only the dead one counts as unresolvable');
  t.deepEqual(mixed.blockers, ['Live.c()V'],
    'the live dependency is named as a blocker, so the caller still installs');
  t.end();
});

// ---------------------------------------------------------------------------
// 4. Recursive dependency groups -- the correctness test
// ---------------------------------------------------------------------------

const MUTUAL_SOURCE = `
public class MutualRecursion {
  // Each arm is deliberately larger than the inliner will absorb: a callee
  // small enough to inline never reaches the linking path at all, and the test
  // would then pass while proving nothing.
  static int ping(int n, int acc) {
    if (n <= 0) return acc;
    acc += (n & 1) * 3 + ((n >> 1) & 1) * 5 + ((n >> 2) & 1) * 7 + ((n >> 3) & 1) * 11;
    acc ^= acc << 3; acc ^= acc >>> 5; acc += n * 17;
    acc ^= acc << 7; acc ^= acc >>> 9; acc += n * 19;
    acc ^= acc << 11; acc ^= acc >>> 13; acc += n * 23;
    return pong(n - 1, acc);
  }

  static int pong(int n, int acc) {
    if (n <= 0) return acc;
    acc += (n & 1) * 13 + ((n >> 1) & 1) * 17 + ((n >> 2) & 1) * 19 + ((n >> 3) & 1) * 23;
    acc ^= acc << 4; acc ^= acc >>> 6; acc += n * 29;
    acc ^= acc << 8; acc ^= acc >>> 10; acc += n * 31;
    acc ^= acc << 12; acc ^= acc >>> 14; acc += n * 37;
    return ping(n - 1, acc);
  }

  // Results come back through an int[] the caller owns: the test harness
  // drives a frame to completion and has no return-value channel.
  static void drive(int[] out, int rounds) {
    int total = 0;
    for (int i = 0; i < rounds; i++) total += ping(24, i);
    out[0] = total;
  }
}
`;

async function runDrive(t, classpath, jvmOptions, rounds) {
  const jvm = new JVM({ classpath, ...jvmOptions });
  await jvm.loadClassByName('MutualRecursion');
  jvm.classInitializationState.set('MutualRecursion', 'INITIALIZED');
  const thread = {
    id: 0,
    name: 'pending-links-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const out = [0];
  out.type = '[I';
  const method = await jvm.findMethodInHierarchy('MutualRecursion', 'drive', '([II)V');
  const frame = new Frame(method);
  frame.className = 'MutualRecursion';
  frame.locals[0] = out;
  frame.locals[1] = rounds;
  const before = thread.callStack.size();
  thread.callStack.push(frame);
  let ticks = 0;
  while (thread.callStack.size() > before) {
    const step = await jvm.executeTick();
    ticks += 1;
    if (step && step.completed) break;
    if (ticks > 50000000) throw new Error('tick limit');
  }
  return { jvm, result: out[0] };
}

// wasmJit.state is a WeakMap, so it cannot be enumerated. Ask it about the two
// methods this fixture is about instead.
async function tierOf(jvm, name, descriptor) {
  const wj = jvm.jit && jvm.jit.wasmJit;
  if (!wj) return 'no-wasmjit';
  const method = await jvm.findMethodInHierarchy('MutualRecursion', name, descriptor);
  const st = wj.state.get(method);
  return st ? st.status : 'never-seen';
}

test('mutually recursive methods agree with the interpreter', async (t) => {
  withEnv(t, {
    JVM_WASM_JIT: '1',
    JVM_WASM_STRUCTURED: '1',
    JVM_WASM_JIT_WARMUP: '1',
  });
  const classpath = compileJavaFixture(t, 'MutualRecursion', MUTUAL_SOURCE);

  // Neither arm can be linked to the other when it is lowered: each is
  // 'compiling' while the other's call site is emitted. Before the late-bound
  // trampoline that demoted both blocks; the contract now is that they still
  // produce the interpreter's answer whichever way they were lowered.
  const interpreted = await runDrive(t, classpath,
    { jit: { enabled: false } }, 200);
  const jitted = await runDrive(t, classpath,
    { jit: { compileWorker: false, warmupThreshold: 10 } }, 200);

  t.equal(typeof interpreted.result, 'number', 'the interpreter produced a number');
  t.notEqual(interpreted.result, 0, 'and a non-trivial one');
  t.equal(jitted.result, interpreted.result,
    'the compiled arms agree with the interpreter on mutual recursion');

  // Without this the equality above could be two interpreters agreeing.
  const ping = await tierOf(jitted.jvm, 'ping', '(II)I');
  const pong = await tierOf(jitted.jvm, 'pong', '(II)I');
  t.ok(ping !== 'never-seen' || pong !== 'never-seen',
    `a recursive arm reached the wasm backend (ping=${ping}, pong=${pong})`);
  t.end();
});

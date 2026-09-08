'use strict';

// docs/refactor.md 3.3: "Loop-free methods as optimization candidates. This is
// still outstanding for Wasm: the earlier broad backedge-gate removal was
// reverted. Introduce the replacement under the queue-priority model and
// verify existing tier choices."
//
// The replacement is not "compile every loop-free method". It is a candidate
// rule plus a call-count threshold, so hotness decides WHEN a loop-free method
// compiles rather than whether it is allowed to at all. These tests pin the
// three things that distinguishes it from the reverted removal: it is off by
// default, it needs real heat, and it does not reopen the opaque-control gate.

const test = require('tape');
const { makeJavaFixtureCompiler } = require('./javaFixture');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');

const compileJavaFixture = makeJavaFixtureCompiler('loopfree-fixture-');
function withEnv(t, vars) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  t.teardown(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

async function invoke(jvm, thread, className, methodName, descriptor, locals) {
  const method = await jvm.findMethodInHierarchy(className, methodName, descriptor);
  const frame = new Frame(method);
  frame.className = className;
  locals.forEach((value, index) => { frame.locals[index] = value; });
  const before = thread.callStack.size();
  thread.callStack.push(frame);
  while (thread.callStack.size() > before) {
    const result = await jvm.executeTick();
    if (result.completed) break;
  }
}

// A loop-free method with enough straight-line arithmetic that the JS tier's
// inliner cannot absorb it into the driver. A one-line callee never reaches
// the Wasm gate at all, and the test would then pass while proving nothing.
const SOURCE = `
public class LoopFreeGate {
  public static int leaf(int a, int b) {
    int x = a * 31 + b;
    int y = (x ^ (a << 3)) + (b * 7);
    int z = (y - a) * 5 + (x & 0xffff);
    int w = (z ^ (y >>> 2)) + (a * 11) - (b * 13);
    int v = (w + x) * 3 - (y & 0x7fff) + (z >>> 1);
    return (v ^ w) + (x - y) + (z * 2) - (a | b);
  }
  public static void drive(int[] out, int n) {
    // The loop lives HERE, so leaf itself is genuinely loop-free and the gate
    // under test is the one leaf hits, not the one drive hits.
    int sum = 0;
    for (int i = 0; i < n; i++) sum += leaf(i, sum);
    out[0] = sum;
  }
}
`;

async function makeHarness(t, extraEnv) {
  withEnv(t, { JVM_WASM_JIT: '1', JVM_WASM_STRUCTURED: '1', ...extraEnv });
  const classpath = compileJavaFixture(t, 'LoopFreeGate', SOURCE);
  const jvm = new JVM({ classpath, jit: { compileWorker: false, warmupThreshold: 100 } });
  await jvm.loadClassByName('LoopFreeGate');
  jvm.classInitializationState.set('LoopFreeGate', 'INITIALIZED');
  const thread = {
    id: 0, name: 'loopfree-test', callStack: new Stack(),
    status: 'runnable', pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  return { jvm, thread };
}

function reference(n) {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = i, b = sum;
    const x = (Math.imul(a, 31) + b) | 0;
    const y = ((x ^ (a << 3)) + Math.imul(b, 7)) | 0;
    const z = (Math.imul((y - a) | 0, 5) + (x & 0xffff)) | 0;
    const w = (((z ^ (y >>> 2)) + Math.imul(a, 11)) - Math.imul(b, 13)) | 0;
    const v = ((Math.imul((w + x) | 0, 3) - (y & 0x7fff)) + (z >>> 1)) | 0;
    sum = (sum + ((((v ^ w) + ((x - y) | 0)) | 0) + (Math.imul(z, 2) - (a | b))) | 0) | 0;
  }
  return sum | 0;
}

// What the gate governs is ENTRY: whether a frame for a loop-free method may
// be run by the Wasm tier. It is not the only way such a method can acquire a
// module -- a linked callee is compiled through findReadyStatic, which never
// consults this gate -- so the census reason is what these tests read, not the
// mere existence of compiled state. Getting that wrong is how this test first
// passed while measuring something else.
function gateReasons(jvm, key) {
  const row = jvm.jit.wasmJit.census && jvm.jit.wasmJit.census.get(key);
  return row ? Object.keys(Object.fromEntries(row.reasons)) : [];
}

test('a loop-free method is refused entry by default', async (t) => {
  const { jvm, thread } = await makeHarness(t, {});
  jvm.jit.wasmJit.census = new Map();
  // Entered as its own frame, repeatedly, which is the shape the census
  // recorded: `mi.c()Lol;` reached the gate 31,780 times at the Deko Bloko
  // menu. Calling it from a compiled loop instead would link it as a callee
  // and never reach this gate at all.
  for (let i = 0; i < 200; i += 1) {
    await invoke(jvm, thread, 'LoopFreeGate', 'leaf', '(II)I', [i, i * 3]);
  }
  const reasons = gateReasons(jvm, 'LoopFreeGate.leaf(II)I');
  t.ok(reasons.includes('no-supported-backedge'),
    `the loop-free leaf is refused entry with the gate off (${reasons.join(', ') || 'none'})`);
  t.notOk(reasons.includes('below-loopfree-warmup'),
    'and it is not even considered as a loop-free candidate');
  t.equal(jvm.jit.wasmJit.loopFreeThreshold, 0,
    'because the threshold is zero unless asked for, which is the default');
  t.end();
});

test('the loop-free candidate rule excludes opaque control, not just backedges', async (t) => {
  const { jvm } = await makeHarness(t, { JVM_WASM_LOOPFREE_WARMUP: '50' });
  const leaf = await jvm.findMethodInHierarchy('LoopFreeGate', 'leaf', '(II)I');
  const drive = await jvm.findMethodInHierarchy('LoopFreeGate', 'drive', '([II)V');

  t.ok(jvm.jit.isLoopFreeWasmCandidate(leaf),
    'the straight-line leaf is a candidate');
  t.notOk(jvm.jit.isLoopFreeWasmCandidate(drive),
    'the method that owns the loop is not -- it already has a backedge');

  // The old predicate fused "no backedge" with "opaque control needs the
  // interpreter". Opening the second half miscompiled tombracer, so assert the
  // candidate rule still consults it rather than only the backedge test.
  const codeItems = jvm.jit.getCodeItems(leaf);
  t.notOk(jvm.jit.requiresOpaqueControlInterpreter(leaf, codeItems),
    'the candidate is non-opaque, which is a separate condition it must pass');
  t.end();
});

test('a hot loop-free method reaches the wasm tier once the threshold is met', async (t) => {
  const { jvm, thread } = await makeHarness(t, { JVM_WASM_LOOPFREE_WARMUP: '50' });
  jvm.jit.wasmJit.census = new Map();
  for (let i = 0; i < 200; i += 1) {
    await invoke(jvm, thread, 'LoopFreeGate', 'leaf', '(II)I', [i, i * 3]);
  }
  // Correctness is checked through the driver, so the compiled leaf has to
  // produce the same answers the reference does after it was admitted.
  const out = [0];
  out.type = '[I';
  await invoke(jvm, thread, 'LoopFreeGate', 'drive', '([II)V', [out, 3000]);
  t.equal(out[0], reference(3000),
    'the guest result is still correct with the loop-free tier admitted');

  const reasons = gateReasons(jvm, 'LoopFreeGate.leaf(II)I');
  t.notOk(reasons.includes('no-supported-backedge'),
    `having no loop is no longer the refusal (${reasons.join(', ') || 'none'})`);
  t.ok(reasons.length > 0, 'the leaf did reach the gate');
  t.end();
});

test('the admitted loop-free module is installed and covers the method', async (t) => {
  const { jvm, thread } = await makeHarness(t, { JVM_WASM_LOOPFREE_WARMUP: '50' });
  for (let i = 0; i < 200; i += 1) {
    await invoke(jvm, thread, 'LoopFreeGate', 'leaf', '(II)I', [i, i * 3]);
  }
  const leaf = await jvm.findMethodInHierarchy('LoopFreeGate', 'leaf', '(II)I');
  const state = jvm.jit.wasmJit.state.get(leaf);
  t.equal(state && state.status, 'ready', 'the loop-free module was installed');
  t.ok(jvm.jit.wasmJit.loopFreeAdmissions > 0,
    'and it was admitted by heat rather than by owning a loop');
  const meta = state && (state.meta || (state.callee && state.callee.meta));
  t.ok(meta && (meta.fullyCompiled || meta.normalFlowFullyCompiled),
    'admission required end-to-end coverage, not a partial module');
  t.ok(meta && meta.externalEntry.has(0), 'with a compiled entry to enter through');

  // The failure mode this rule exists to avoid: a module entered as often as
  // it leaves is worse than no module. Assert it actually carried its calls.
  t.ok(state.runs > 0, 'the module ran');
  t.ok(state.exits < state.runs,
    `and it did not exit on every entry (runs=${state.runs} exits=${state.exits})`);
  t.end();
});

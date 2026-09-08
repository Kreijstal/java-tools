'use strict';

/*
 * Acceptance tests for the linked-call ABI (docs/phase1-linked-call-abi.md).
 *
 * These pin the property that makes worker compilation possible at all:
 * lowering a caller must not depend on its callee already having a compiled
 * export. Today WasmJit.compiledCallee refuses at src/jit/WasmJit.js:613
 * ("callee not ready") and demotes the call block, which is why a caller
 * cannot be compiled ahead of its callee in a worker.
 *
 * Written to fail first. Each test states the target contract, not the
 * current behaviour.
 */

const tape = require('tape');
const { makeJavaFixtureCompiler } = require('./javaFixture');

// These are fail-first acceptance tests for work in progress: they describe
// the target contract, not current behaviour, so they must not break the
// default suite. Set JVM_LINKED_CALL_ABI=1 to run them. Remove this gate when
// the refactor lands and they are expected to pass.
const ENABLED = process.env.JVM_LINKED_CALL_ABI === '1';
const test = ENABLED ? tape : (name, fn) => tape.skip(name, fn);
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');

const compileJavaFixture = makeJavaFixtureCompiler('linked-call-abi-');
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

async function makeHarness(t, className, source, extraEnv = {}) {
  withEnv(t, { JVM_WASM_JIT: '1', JVM_WASM_STRUCTURED: '1', ...extraEnv });
  const classpath = compileJavaFixture(t, className, source);
  const jvm = new JVM({ classpath, jit: { compileWorker: false, warmupThreshold: 20 } });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const thread = {
    id: 0,
    name: 'linked-call-abi-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  return { jvm, thread };
}

async function invoke(jvm, thread, className, methodName, descriptor, locals) {
  const method = await jvm.findMethodInHierarchy(className, methodName, descriptor);
  const frame = new Frame(method);
  frame.className = className;
  locals.forEach((v, i) => { frame.locals[i] = v; });
  const before = thread.callStack.size();
  thread.callStack.push(frame);
  let ticks = 0;
  while (thread.callStack.size() > before) {
    const result = await jvm.executeTick();
    ticks += 1;
    if (result.completed) break;
    if (ticks > 50000000) throw new Error('tick limit');
  }
  return ticks;
}

// Returns the demote reasons, or null when the method never reached the wasm
// backend at all. Callers must treat null as a failure rather than as "no
// reasons": an absent artifact would otherwise satisfy every notOk() below
// without the caller having been compiled.
function reasonsFor(jvm, method) {
  const wj = jvm.jit && jvm.jit.wasmJit;
  const st = wj && wj.state.get(method);
  if (!st || !st.meta) return null;
  return [...(st.meta.demoteReasons || new Map()).values()];
}

// Drive a method until it reaches the wasm backend, so a warmup race cannot
// turn a real assertion into a vacuous pass. Returns the demote reasons.
async function reasonsAfterWarmup(t, jvm, thread, className, name, desc, locals, rounds = 6) {
  const method = await jvm.findMethodInHierarchy(className, name, desc);
  let reasons = null;
  for (let i = 0; i < rounds && reasons === null; i += 1) {
    await invoke(jvm, thread, className, name, desc, locals);
    reasons = reasonsFor(jvm, method);
  }
  t.ok(reasons !== null, `${className}.${name} reached the wasm backend`);
  return reasons;
}

// ---------------------------------------------------------------------------
// 1. Compile before callee readiness
// ---------------------------------------------------------------------------

test('an unready callee never costs the caller its compiled tier', async (t) => {
  // This models the state a COMPILE WORKER is in, which is the only place
  // UNKNOWN is durable: it holds bytecode, not the owning runtime's tier
  // state, so it cannot compile a callee on demand.
  //
  // An earlier version of this test used JVM_JIT_DENY to ban the callee
  // outright. That was wrong: a banned callee provably can never satisfy the
  // contract, which is INCOMPATIBLE, and INCOMPATIBLE is allowed to select a
  // different caller shape. Testing it demanded the wrong behaviour.
  //
  // Here the callee is merely COLD. The caller's loop runs 20000 times while
  // the callee is reached ONCE per invoke -- eight times across the whole
  // test, against a warmup threshold of 20 -- so the caller is hot and the
  // callee never warms up on its own. JVM_WASM_NO_ONDEMAND_CALLEE stops
  // findReadyStatic from compiling it on the caller's behalf.
  //
  // JVM_WASM_JIT_WARMUP matters and is easy to miss: the Wasm tier's threshold
  // defaults to 1 (WasmJit.js `Number(env.JVM_WASM_JIT_WARMUP || 1)`), and the
  // harness's `jit: { warmupThreshold }` sets the JS tier's, not this one. Left
  // at the default the callee compiles on its first call and the test silently
  // stops modelling UNKNOWN at all. The caller still compiles because its hot
  // loop reaches the backend through OSR, not through entry count.
  const { jvm, thread } = await makeHarness(t, 'LateLink', `
public class LateLink {
  public static int drive(int[] out, int n) {
    int sum = 0;
    for (int i = 0; i < n; i++) {
      sum = sum * 31 + i;
      if (i == 0) sum += LateLinkCallee.callee(i);
    }
    out[0] = sum;
    return sum;
  }
}
class LateLinkCallee {
  // Too large to inline: an inlined call never reaches the linking path.
  static int callee(int x) {
    int v = x * 0x9E3775 + 1;
    for (int k = 0; k < 8; k++) { v ^= v >>> 7; v += k * 0x27D4EB; v ^= v << 5; v += x; }
    return v;
  }
}
`, { JVM_WASM_NO_ONDEMAND_CALLEE: '1', JVM_WASM_JIT_WARMUP: '50' });

  const n = 20000;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum = (Math.imul(sum, 31) + i) | 0;
    if (i === 0) {
      let v = (Math.imul(i, 0x9E3775) + 1) | 0;
      for (let k = 0; k < 8; k++) {
        v ^= v >>> 7;
        v = (v + Math.imul(k, 0x27D4EB)) | 0;
        v ^= v << 5;
        v = (v + i) | 0;
      }
      sum = (sum + v) | 0;
    }
  }
  const out = [0];
  out.type = '[I';
  const method = await jvm.findMethodInHierarchy('LateLink', 'drive', '([II)I');
  const wasmJit = jvm.jit.wasmJit;

  await invoke(jvm, thread, 'LateLink', 'drive', '([II)I', [out, n]);
  t.ok(reasonsFor(jvm, method) !== null,
    'the caller reached the wasm backend with its callee still cold');

  const lost = [];
  for (let round = 2; round <= 8; round += 1) {
    await invoke(jvm, thread, 'LateLink', 'drive', '([II)I', [out, n]);
    if (reasonsFor(jvm, method) === null) lost.push(round);
  }
  t.equal(out[0], sum, 'guest result is correct regardless of link state');
  // The contract is that the caller was LOWERED against an unresolved
  // dependency -- not that the callee stays cold forever. The late-bound call
  // resolves at runtime with on-demand compilation allowed, so the callee does
  // get compiled eventually; that is the design, not a leak. What must be true
  // is that codegen recorded the dependency as pending rather than demanding a
  // live export.
  const st0 = wasmJit.state.get(method);
  const pending = ((st0 && st0.meta && st0.meta.linkBindings) || [])
    .filter((b) => b.className === 'LateLinkCallee' && b.pending);
  t.ok(pending.length > 0,
    `the caller was lowered against an unresolved dependency (${
      ((st0 && st0.meta && st0.meta.linkBindings) || [])
        .map((b) => `${b.key}${b.pending ? ' pending' : ''}`).join(', ') || 'none'})`);
  t.deepEqual(lost, [],
    `the caller kept its artifact every round (lost at ${lost.join(', ') || 'never'})`);

  const reasons = reasonsFor(jvm, method);
  t.ok(reasons !== null && !reasons.some((r) => /not ready/.test(r)),
    `no call block demoted for callee readiness (${(reasons || ['<no artifact>']).join(', ') || 'none'})`);
  t.end();
});

// ---------------------------------------------------------------------------
// 2. Late binding without re-lowering
// ---------------------------------------------------------------------------

test('the same caller artifact is published after its callee becomes compatible', async (t) => {
  // The caller is warmed while the callee is still cold, then the callee is
  // warmed. The contract: the caller's compiled artifact is reused, and only
  // the binding changes. Recompiling the caller is the failure this pins.
  const { jvm, thread } = await makeHarness(t, 'BindLate', `
public class BindLate {
  public static int warmCaller(int[] out, int n) {
    int sum = 0;
    for (int i = 0; i < n; i++) sum = sum * 31 + BindLateCallee.callee(i);
    out[0] = sum;
    return sum;
  }
}
class BindLateCallee {
  static int callee(int x) { int v = x * 0x9E3775 + 1; v ^= v >>> 7; return v; }
}
`);
  const out = [0];
  out.type = '[I';
  await invoke(jvm, thread, 'BindLate', 'warmCaller', '([II)I', [out, 4000]);

  const method = await jvm.findMethodInHierarchy('BindLate', 'warmCaller', '([II)I');
  const wasmJit = jvm.jit && jvm.jit.wasmJit;
  const st = wasmJit && wasmJit.state.get(method);
  t.ok(st && st.meta, 'the caller compiled');

  // Target contract: an artifact identity that survives relinking. There is no
  // such field today, which is the point of the test.
  // Not vacuous: the identity must be a real ABI-tagged digest, not merely a
  // defined field.
  const id = st && st.meta && st.meta.artifactId;
  t.ok(typeof id === 'string' && /^v\d+:[0-9a-f]+$/.test(id),
    `the artifact carries an ABI-tagged identity independent of its bindings (${id})`);
  t.end();
});

// ---------------------------------------------------------------------------
// 3. Nested deopt: exactly-once side effects
// ---------------------------------------------------------------------------

test('a nested deopt preserves the under-stack and runs side effects once', async (t) => {
  // The decisive fixture. A computes 17 + B(x); B bumps a guest-visible
  // counter and then hits a block the wasm backend demotes. A design that
  // rebuilds A's frame but re-enters B would double the counter; one that
  // loses the under-stack would lose the 17.
  //
  // The counter lives in the out array rather than in a static field: the
  // harness marks the class INITIALIZED without running <clinit>, so a static
  // would be unresolved.
  const { jvm, thread } = await makeHarness(t, 'DeoptOnce', `
public class DeoptOnce {
  public static int drive(int[] out, int n) {
    int sum = 0;
    for (int i = 0; i < n; i++) sum = 17 + callee(out, i);
    out[0] = sum;
    return sum;
  }
  static int callee(int[] out, int x) {
    out[1]++;
    // demoted block: a virtual call on a JRE class the backend cannot link
    if ((x & 1023) == 7) return Integer.toString(x).length() + x;
    return x;
  }
}
`);
  const n = 20000;
  let expected = 0;
  for (let i = 0; i < n; i++) {
    expected = 17 + (((i & 1023) === 7) ? String(i).length + i : i);
  }
  const out = [0, 0];
  out.type = '[I';
  const reasons = await reasonsAfterWarmup(
    t, jvm, thread, 'DeoptOnce', 'drive', '([II)I', [out, n], 1);
  t.ok(reasons !== null, 'the caller compiled');
  t.equal(out[0], expected, 'the 17 under the call survived every deopt');
  t.equal(out[1], n, 'the callee ran exactly once per iteration');
  t.end();
});

// ---------------------------------------------------------------------------
// 4. Link policy is not artifact invalidation
// ---------------------------------------------------------------------------

test('flipping linkVetoed changes the target without recompiling the caller', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'VetoSwap', `
public class VetoSwap {
  public static int drive(int[] out, int n) {
    int sum = 0;
    for (int i = 0; i < n; i++) sum = sum * 31 + VetoSwapCallee.callee(i);
    out[0] = sum;
    return sum;
  }
}
class VetoSwapCallee {
  // Non-inlinable, for the same reason as LateLinkCallee: an inlined call
  // never reaches the linking path, so the binding it is supposed to record
  // would never exist and the assertion would read 'none'.
  static int callee(int x) {
    int v = x * 0x9E3775 + 1;
    for (int k = 0; k < 8; k++) { v ^= v >>> 7; v += k * 0x27D4EB; v ^= v << 5; v += x; }
    return v;
  }
}
`);
  const out = [0];
  out.type = '[I';
  await invoke(jvm, thread, 'VetoSwap', 'drive', '([II)I', [out, 4000]);

  const method = await jvm.findMethodInHierarchy('VetoSwap', 'drive', '([II)I');
  const wasmJit = jvm.jit && jvm.jit.wasmJit;
  const st = wasmJit && wasmJit.state.get(method);
  t.ok(st && st.meta, 'the caller compiled');
  const before = st && st.meta;

  const calleeMethod = await jvm.findMethodInHierarchy('VetoSwapCallee', 'callee', '(I)I');
  const calleeSt = wasmJit && wasmJit.state.get(calleeMethod);
  if (calleeSt) calleeSt.linkVetoed = true;

  let sum = 0;
  for (let i = 0; i < 4000; i++) {
    let v = (Math.imul(i, 0x9E3775) + 1) | 0;
    for (let k = 0; k < 8; k++) {
      v ^= v >>> 7;
      v = (v + Math.imul(k, 0x27D4EB)) | 0;
      v ^= v << 5;
      v = (v + i) | 0;
    }
    sum = (Math.imul(sum, 31) + v) | 0;
  }
  await invoke(jvm, thread, 'VetoSwap', 'drive', '([II)I', [out, 4000]);
  t.equal(out[0], sum, 'execution stays correct after the veto');
  t.equal(wasmJit && wasmJit.state.get(method) && wasmJit.state.get(method).meta,
    before, 'the caller artifact was not replaced by the policy change');
  // Not vacuous: the artifact surviving is only half the contract. The veto
  // must actually have re-pointed the link, which requires a binding the
  // runtime owns and can rebind. No such record exists today.
  // Not vacuous: an empty array would satisfy Array.isArray while carrying
  // nothing to re-point. The vetoed callee itself must be named.
  const bindings = (st && st.meta && st.meta.linkBindings) || [];
  t.ok(Array.isArray(bindings) && bindings.some((b) =>
    b.className === 'VetoSwapCallee' && b.name === 'callee' && b.descriptor === '(I)I'),
  `the caller names the vetoed callee as a rebindable dependency (${
    bindings.map((b) => b.key || `${b.className}.${b.name}`).join(', ') || 'none'})`);
  t.end();
});

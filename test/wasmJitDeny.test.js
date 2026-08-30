'use strict';

const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');

/*
 * JVM_JIT_DENY is the bisection lever: denying a class must remove every
 * compiled copy of its methods so a miscompile can be attributed to one class
 * without disabling a whole tier. The Wasm tier consulted no deny list, so a
 * denied class kept its module compiled and running and looked innocent --
 * a bisect over a hot method then blamed the wrong class.
 *
 * Two admission paths need the gate: prepare(), which is how a frame enters
 * the tier at all, and compile(), which callee inlining reaches directly.
 */

const SOURCE = `
public class WasmDenyProbe {
  public static int drive(int[] out, int n) {
    int sum = 0;
    for (int i = 0; i < n; i++) sum = sum * 31 + (i ^ (sum >>> 16));
    out[0] = sum;
    return sum;
  }
}
`;

function withEnv(t, env) {
  const saved = {};
  for (const [key, value] of Object.entries(env)) {
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

function compileFixture(t, className, source) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wasm-deny-'));
  t.teardown(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const sourcePath = path.join(tempDir, `${className}.java`);
  fs.writeFileSync(sourcePath, source);
  execFileSync('javac', ['-g', '-d', tempDir, sourcePath], { stdio: 'inherit' });
  return tempDir;
}

async function makeHarness(t, className, source) {
  withEnv(t, { JVM_WASM_JIT: '1', JVM_WASM_STRUCTURED: '1' });
  const classpath = compileFixture(t, className, source);
  const jvm = new JVM({ classpath, jit: { warmupThreshold: 100 } });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const thread = {
    id: 0,
    name: 'wasm-deny-test',
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
  locals.forEach((value, index) => { frame.locals[index] = value; });
  const before = thread.callStack.size();
  thread.callStack.push(frame);
  while (thread.callStack.size() > before) await jvm.executeTick(thread);
  return method;
}

function reference(n) {
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum = (Math.imul(sum, 31) + (i ^ (sum >>> 16))) | 0;
  return sum;
}

function makeOut() {
  const out = [0];
  out.type = '[I';
  return out;
}

const N = 5000;

test('an undenied class still reaches the Wasm tier', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'WasmDenyProbe', SOURCE);
  const out = makeOut();
  const method = await invoke(
    jvm, thread, 'WasmDenyProbe', 'drive', '([II)I', [out, N]);
  t.equal(out[0], reference(N), 'the loop computes the reference value');
  const state = jvm.jit.wasmJit.state.get(method);
  t.ok(state && state.status === 'ready',
    'the hot loop compiles to a Wasm module when nothing is denied');
  t.end();
});

test('a frozen Wasm compiler leaves cold methods on the canonical tier',
  async (t) => {
    const {jvm, thread} = await makeHarness(t, 'WasmDenyProbe', SOURCE);
    jvm.jit.wasmJit.freezeCompilation();
    const first = makeOut();
    const method = await invoke(
      jvm, thread, 'WasmDenyProbe', 'drive', '([II)I', [first, N]);
    t.equal(first[0], reference(N),
      'freezing compilation does not change interpreter semantics');
    t.notEqual(jvm.jit.wasmJit.state.get(method)?.status, 'ready',
      'a cold method does not synchronously compile while frozen');

    jvm.jit.wasmJit.thawCompilation();
    const second = makeOut();
    await invoke(jvm, thread, 'WasmDenyProbe', 'drive', '([II)I', [second, N]);
    t.equal(second[0], reference(N),
      'thawing retains the same result');
    t.equal(jvm.jit.wasmJit.state.get(method)?.status, 'ready',
      'the same cold method may compile after an explicit thaw');
    t.end();
  });

test('JVM_JIT_DENY keeps a denied class off the Wasm tier', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'WasmDenyProbe', SOURCE);
  // Set the parsed cache directly rather than process.env so this cannot
  // leak a deny list into another test in the same process.
  jvm.jit.jitDenyClasses = new Set(['WasmDenyProbe']);
  const out = makeOut();
  const method = await invoke(
    jvm, thread, 'WasmDenyProbe', 'drive', '([II)I', [out, N]);
  t.equal(out[0], reference(N),
    'denying the class changes tiering, never the computed result');
  const state = jvm.jit.wasmJit.state.get(method);
  t.notOk(state && state.status === 'ready',
    'no Wasm module is compiled for a denied class');
  t.deepEqual(
    jvm.jit.wasmJit.compiled.filter((entry) => entry.key &&
      entry.key.startsWith('WasmDenyProbe.')).map((entry) => entry.key),
    [], 'the denied class contributes no compiled Wasm module');
  t.end();
});

test('a denied class is refused by the callee-inline compile path', async (t) => {
  const { jvm } = await makeHarness(t, 'WasmDenyProbe', SOURCE);
  jvm.jit.jitDenyClasses = new Set(['WasmDenyProbe']);
  const method = await jvm.findMethodInHierarchy(
    'WasmDenyProbe', 'drive', '([II)I');
  // Callee inlining calls compile() directly, bypassing prepare().
  const state = jvm.jit.wasmJit.methodState({ method, className: 'WasmDenyProbe' });
  jvm.jit.wasmJit.compile(
    { method, className: 'WasmDenyProbe' }, state, { asCallee: true });
  t.equal(state.status, 'failed',
    'the callee compile path refuses a denied class');
  t.equal(state.failReason, 'jit-denied',
    'the refusal is attributed to the deny list, not a translation blocker');
  t.end();
});

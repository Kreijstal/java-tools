'use strict';

// Linear-heap primitive arrays (JVM_WASM_HEAP=1): guest newarray allocates
// TypedArray views over one wasm memory; the structured backend inlines
// element access as bounds check + raw load/store behind per-array base/len
// caches, falling back to the aget/aset imports for null or non-heap arrays.

const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');

function compileJavaFixture(t, className, source) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heap-arr-fixture-'));
  t.teardown(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  const sourcePath = path.join(tempDir, `${className}.java`);
  fs.writeFileSync(sourcePath, source);
  execFileSync('javac', ['-g', '-d', tempDir, sourcePath], { stdio: 'inherit' });
  return tempDir;
}

async function invoke(jvm, thread, className, methodName, descriptor, locals) {
  const method = await jvm.findMethodInHierarchy(className, methodName, descriptor);
  const frame = new Frame(method);
  frame.className = className;
  locals.forEach((value, index) => {
    frame.locals[index] = value;
  });
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

async function makeHarness(t, className, source) {
  withEnv(t, {
    JVM_WASM_JIT: '1', JVM_WASM_STRUCTURED: '1', JVM_WASM_HEAP: '1',
    JVM_WASM_HEAP_MB: '16',
  });
  const classpath = compileJavaFixture(t, className, source);
  const jvm = new JVM({ classpath, jit: { warmupThreshold: 100 } });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const thread = {
    id: 0,
    name: 'heap-arr-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  return { jvm, thread };
}

function metaOf(jvm, key) {
  const st = jvm.jit.wasmJit.compiled.find((s) => s.key === key);
  return st && st.meta;
}

const SOURCE = `
public class HeapArr {
  public static int sumInt(int[] a, int n) {
    int s = 0;
    for (int i = 0; i < n; i++) s += a[i];
    return s;
  }
  public static void fill(int[] a, int n) {
    for (int i = 0; i < n; i++) a[i] = i * 3;
  }
  public static void oobCatch(int[] out, int[] a, int n) {
    int r;
    try { r = sumInt(a, n); } catch (ArrayIndexOutOfBoundsException e) { r = -7; }
    out[0] = r;
  }
  public static void nullCatch(int[] out, int n) {
    int r;
    try { r = sumInt(null, n); } catch (NullPointerException e) { r = -3; }
    out[0] = r;
  }
  public static void byteRound(int[] out, int n) {
    byte[] b = new byte[n];
    int s = 0;
    for (int i = 0; i < n; i++) { b[i] = (byte)(i + 200); s += b[i]; }
    out[0] = s;
  }
  public static void charRound(int[] out, int n) {
    char[] c = new char[n];
    int s = 0;
    for (int i = 0; i < n; i++) { c[i] = (char)(i - 1); s += c[i]; }
    out[0] = s;
  }
  public static void longRound(int[] out, int n) {
    long[] a = new long[n];
    long s = 0;
    for (int i = 0; i < n; i++) { a[i] = 4000000000L + i; s += a[i]; }
    out[0] = (int) s;
  }
  public static void floatRound(int[] out, int n) {
    float[] f = new float[n];
    float s = 0f;
    for (int i = 0; i < n; i++) { f[i] = i * 0.5f; s += f[i]; }
    out[0] = (int) s;
  }
  public static void rowSum(int[] out, int[][] m, int rows, int cols) {
    int s = 0;
    for (int i = 0; i < rows; i++) {
      int[] row = m[i];
      for (int j = 0; j < cols; j++) s += row[j];
    }
    out[0] = s;
  }
  public static void chainSum(int[] out, Node h, int n) {
    int s = 0;
    for (int i = 0; i < n; i++) { s += h.v; h = h.next; }
    out[0] = s;
  }
}
class Node { int v; Node next; }
`;

const N = 5000;

test('heap int[] reads: raw loads match, base/len cache present', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'HeapArr', SOURCE);
  const a = jvm.wasmHeap.alloc('[I', N);
  a.type = '[I';
  for (let i = 0; i < N; i += 1) a[i] = i * 7;
  const out = [0];
  out.type = '[I';
  await invoke(jvm, thread, 'HeapArr', 'oobCatch', '([I[II)V', [out, a, N]);
  let expect = 0;
  for (let i = 0; i < N; i += 1) expect = (expect + i * 7) | 0;
  t.equal(out[0], expect, 'sum over a heap-backed view is exact');
  const meta = metaOf(jvm, 'HeapArr.sumInt([II)I');
  t.ok(meta && meta.structured, 'sumInt compiled by the structured backend');
  t.ok(meta.arrayCacheCount >= 1, 'array base/len cache registered');
  t.end();
});

test('heap int[] writes land in wasm memory (aliasing proof)', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'HeapArr', SOURCE);
  const a = jvm.wasmHeap.alloc('[I', N);
  a.type = '[I';
  await invoke(jvm, thread, 'HeapArr', 'fill', '([II)V', [a, N]);
  t.equal(a[1234], 1234 * 3, 'write visible through the JS view');
  const raw = new Int32Array(jvm.wasmHeap.memory.buffer, a.wasmBase, N);
  t.equal(raw[4321], 4321 * 3, 'write visible through raw wasm memory');
  t.end();
});

test('legacy plain arrays take the import fallback and stay correct', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'HeapArr', SOURCE);
  const a = new Array(N).fill(0);
  a.type = '[I';
  for (let i = 0; i < N; i += 1) a[i] = i * 5;
  const out = [0];
  out.type = '[I';
  await invoke(jvm, thread, 'HeapArr', 'oobCatch', '([I[II)V', [out, a, N]);
  let expect = 0;
  for (let i = 0; i < N; i += 1) expect = (expect + i * 5) | 0;
  t.equal(out[0], expect, 'plain-array sum matches through the fallback path');
  t.end();
});

test('out-of-bounds and null throw the guest exceptions', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'HeapArr', SOURCE);
  const a = jvm.wasmHeap.alloc('[I', N);
  a.type = '[I';
  const out = [0];
  out.type = '[I';
  await invoke(jvm, thread, 'HeapArr', 'oobCatch', '([I[II)V', [out, a, N]);
  t.ok(metaOf(jvm, 'HeapArr.sumInt([II)I'), 'sumInt is compiled before the failure runs');
  await invoke(jvm, thread, 'HeapArr', 'oobCatch', '([I[II)V', [out, a, N + 5]);
  t.equal(out[0], -7, 'past-end read surfaces AIOOBE through the bounds check');
  await invoke(jvm, thread, 'HeapArr', 'nullCatch', '([II)V', [out, N]);
  t.equal(out[0], -3, 'null array surfaces NPE through the import fallback');
  t.end();
});

test('loop-carried array receiver: cache refills when the row changes', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'HeapArr', SOURCE);
  const rows = 200;
  const cols = 40;
  const m = new Array(rows).fill(null);
  m.type = '[[I';
  let expect = 0;
  for (let i = 0; i < rows; i += 1) {
    const row = jvm.wasmHeap.alloc('[I', cols);
    row.type = '[I';
    for (let j = 0; j < cols; j += 1) {
      row[j] = i * 1000 + j;
      expect = (expect + row[j]) | 0;
    }
    m[i] = row;
  }
  const out = [0];
  out.type = '[I';
  // hot-loop it so the compiled body (not the interpreter) computes the sum
  for (let k = 0; k < 150; k += 1) {
    await invoke(jvm, thread, 'HeapArr', 'rowSum', '([I[[III)V', [out, m, rows, cols]);
  }
  t.equal(out[0], expect, 'every row read through its own base, not row 0’s');
  t.ok(metaOf(jvm, 'HeapArr.rowSum([I[[III)V'), 'rowSum is compiled');
  t.end();
});

test('loop-phi field receiver: field cache refills as the node advances', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'HeapArr', SOURCE);
  const n = 300;
  let head = null;
  let expect = 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    head = { type: 'Node', fields: { 'Node.v': i * 7, 'Node.next': head } };
  }
  for (let i = 0; i < n; i += 1) expect = (expect + i * 7) | 0;
  const out = [0];
  out.type = '[I';
  for (let k = 0; k < 150; k += 1) {
    await invoke(jvm, thread, 'HeapArr', 'chainSum', '([ILNode;I)V', [out, head, n]);
  }
  t.equal(out[0], expect, 'walk reads each node’s field, not the first forever');
  t.ok(metaOf(jvm, 'HeapArr.chainSum([ILNode;I)V'), 'chainSum is compiled');
  t.end();
});

test('narrow and wide element types keep Java coercion semantics', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'HeapArr', SOURCE);
  const out = [0];
  out.type = '[I';

  await invoke(jvm, thread, 'HeapArr', 'byteRound', '([II)V', [out, N]);
  let bs = 0;
  for (let i = 0; i < N; i += 1) bs = (bs + (((i + 200) << 24) >> 24)) | 0;
  t.equal(out[0], bs, 'byte[] store truncates to signed 8-bit');

  await invoke(jvm, thread, 'HeapArr', 'charRound', '([II)V', [out, N]);
  let cs = 0;
  for (let i = 0; i < N; i += 1) cs = (cs + ((i - 1) & 0xffff)) | 0;
  t.equal(out[0], cs, 'char[] store wraps unsigned 16-bit');

  await invoke(jvm, thread, 'HeapArr', 'longRound', '([II)V', [out, N]);
  let ls = 0n;
  for (let i = 0; i < N; i += 1) ls += 4000000000n + BigInt(i);
  t.equal(out[0], Number(BigInt.asIntN(32, ls)), 'long[] round trip is exact');

  await invoke(jvm, thread, 'HeapArr', 'floatRound', '([II)V', [out, N]);
  t.equal(out[0], (N * (N - 1)) / 4, 'float[] halves sum exactly');
  t.end();
});

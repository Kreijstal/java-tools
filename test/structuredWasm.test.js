'use strict';

const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');

function compileJavaFixture(t, className, source) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'structured-fixture-'));
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

async function makeHarness(t, className, source, extraEnv = {}) {
  withEnv(t, { JVM_WASM_JIT: '1', JVM_WASM_STRUCTURED: '1', ...extraEnv });
  const classpath = compileJavaFixture(t, className, source);
  const jvm = new JVM({ classpath, jit: { warmupThreshold: 100 } });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const thread = {
    id: 0,
    name: 'structured-wasm-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  return { jvm, thread };
}

function structuredKeys(jvm) {
  return jvm.jit.wasmJit.compiled
    .filter((st) => st.meta && st.meta.structured)
    .map((st) => st.key);
}

test('structured wasm compiles an int loop with branches and matches semantics', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'StructuredLoop', `
public class StructuredLoop {
  public static int drive(int[] out, int n) {
    int sum = 0;
    for (int i = 0; i < n; i++) {
      if ((i & 1) == 0) sum += i * 3;
      else sum -= i;
    }
    out[0] = sum;
    return sum;
  }
}
`);
  const n = 5000;
  let expected = 0;
  for (let i = 0; i < n; i++) {
    if ((i & 1) === 0) expected += i * 3; else expected -= i;
  }
  expected |= 0;
  const out = [0];
  out.type = '[I';
  await invoke(jvm, thread, 'StructuredLoop', 'drive', '([II)I', [out, n]);
  t.equal(out[0], expected, 'loop result matches JS reference');
  t.ok(structuredKeys(jvm).includes('StructuredLoop.drive([II)I'),
    'drive compiled by the structured backend');
  t.end();
});

test('structured wasm long/float/double arithmetic and comparisons', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'StructuredNumerics', `
public class StructuredNumerics {
  public static long drive(long[] out, int n) {
    long acc = 1L;
    double d = 0.5;
    float f = 1.5f;
    for (int i = 1; i <= n; i++) {
      acc = acc * 3L + (long) i;
      acc ^= (acc >>> 7);
      d = d * 1.0001 + (double) i;
      f = f + 0.25f;
      if (d > 100000.0) d = d - 100000.0;
      if (f > 1000.0f) f = 0.5f;
    }
    long mix = acc + (long) d + (long) f;
    out[0] = mix;
    return mix;
  }
}
`);
  // JS reference with BigInt for long semantics
  const n = 3000;
  const MASK = (1n << 64n) - 1n;
  const toS64 = (v) => {
    v &= MASK;
    return v >= (1n << 63n) ? v - (1n << 64n) : v;
  };
  let acc = 1n;
  let d = 0.5;
  let f = Math.fround(1.5);
  for (let i = 1; i <= n; i++) {
    acc = toS64(acc * 3n + BigInt(i));
    const shifted = (acc & MASK) >> 7n;
    acc = toS64(acc ^ shifted);
    d = d * 1.0001 + i;
    f = Math.fround(f + Math.fround(0.25));
    if (d > 100000.0) d = d - 100000.0;
    if (f > 1000.0) f = Math.fround(0.5);
  }
  const expected = toS64(acc + BigInt(Math.trunc(d)) + BigInt(Math.trunc(f)));
  const out = [0n];
  out.type = '[J';
  await invoke(jvm, thread, 'StructuredNumerics', 'drive', '([JI)J', [out, n]);
  t.equal(out[0], expected, 'long/double/float mix matches BigInt/JS reference');
  t.ok(structuredKeys(jvm).includes('StructuredNumerics.drive([JI)J'),
    'compiled by the structured backend');
  t.end();
});

test('structured wasm switch, statics, fields, and Math intrinsics', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'StructuredMixed', `
public class StructuredMixed {
  static int seed;
  int scale;
  public static int drive(int[] out, int n) {
    StructuredMixed m = new StructuredMixed();
    m.scale = 3;
    seed = 7;
    int sum = 0;
    for (int i = 0; i < n; i++) {
      switch (i % 5) {
        case 0: sum += seed; break;
        case 1: sum += m.scale; break;
        case 2: sum += Math.abs(2 - i); break;
        case 4: sum -= 1; break;
        default: sum += 2; break;
      }
      seed = sum & 0xff;
    }
    out[0] = sum;
    return sum;
  }
}
`);
  const n = 4000;
  let sum = 0;
  let seed = 7;
  const scale = 3;
  for (let i = 0; i < n; i++) {
    switch (i % 5) {
      case 0: sum += seed; break;
      case 1: sum += scale; break;
      case 2: sum += Math.abs(2 - i); break;
      case 4: sum -= 1; break;
      default: sum += 2; break;
    }
    sum |= 0;
    seed = sum & 0xff;
  }
  const out = [0];
  out.type = '[I';
  await invoke(jvm, thread, 'StructuredMixed', 'drive', '([II)I', [out, n]);
  t.equal(out[0], sum, 'switch/static/field/Math mix matches JS reference');
  // drive itself allocates (new) so it stays on the dispatcher tier; the
  // structured tier must still handle the loop when factored without `new`.
  t.end();
});

test('structured wasm array kernel (scanline-shaped) compiles and matches', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'StructuredKernel', `
public class StructuredKernel {
  public static int fill(int[] dst, int off, int len, int color, int step) {
    int checksum = 0;
    for (int i = 0; i < len; i++) {
      int v = color + i * step;
      dst[off + i] = v;
      checksum = (checksum * 31 + v) | 0;
    }
    return checksum;
  }
  public static int drive(int[] dst, int rounds) {
    int acc = 0;
    for (int r = 0; r < rounds; r++) {
      acc ^= fill(dst, 0, dst.length, r * 17, r & 3);
    }
    return acc;
  }
}
`);
  const len = 256;
  const rounds = 400;
  const dst = new Array(len).fill(0);
  dst.type = '[I';
  let acc = 0;
  const ref = new Array(len).fill(0);
  for (let r = 0; r < rounds; r++) {
    let checksum = 0;
    for (let i = 0; i < len; i++) {
      const v = (r * 17 + i * (r & 3)) | 0;
      ref[i] = v;
      checksum = ((Math.imul(checksum, 31) + v) | 0);
    }
    acc = (acc ^ checksum) | 0;
  }
  const method = await jvm.findMethodInHierarchy('StructuredKernel', 'drive', '([II)I');
  t.ok(method, 'drive found');
  await invoke(jvm, thread, 'StructuredKernel', 'drive', '([II)I', [dst, rounds]);
  t.deepEqual(dst.slice(0, 8), ref.slice(0, 8), 'array contents match');
  const keys = structuredKeys(jvm);
  t.ok(keys.includes('StructuredKernel.fill([IIIII)I'),
    `fill compiled structured (structured: ${keys.join(', ') || 'none'})`);
  t.end();
});

test('structured wasm compiles methods with exception tables (loop outside range)', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'StructuredCatch', `
public class StructuredCatch {
  public static int drive(int[] out, int n) {
    int sum = 0;
    for (int i = 0; i < n; i++) sum = sum * 31 + (i ^ (sum >>> 16));
    int guard = 0;
    try { guard = 100 / (n - n); } catch (ArithmeticException e) { guard = 7; }
    out[0] = sum + guard;
    return sum + guard;
  }
}
`);
  const n = 5000;
  let sum = 0;
  for (let i = 0; i < n; i++) sum = (Math.imul(sum, 31) + (i ^ (sum >>> 16))) | 0;
  const out = [0];
  out.type = '[I';
  await invoke(jvm, thread, 'StructuredCatch', 'drive', '([II)I', [out, n]);
  t.equal(out[0], (sum + 7) | 0, 'loop + interpreted catch path matches reference');
  t.ok(structuredKeys(jvm).includes('StructuredCatch.drive([II)I'),
    'compiled by the structured backend despite the exception table');
  const method = await jvm.findMethodInHierarchy('StructuredCatch', 'drive', '([II)I');
  const st = jvm.jit.wasmJit.state.get(method);
  t.notOk([...st.meta.demoteReasons.values()].includes('live handler range'),
    `try range compiles under EH (${[...st.meta.demoteReasons.values()].join(', ') || 'none'})`);
  t.ok(st.meta.usedEh, 'EH catch sites were emitted for the try range');
  t.notOk(st.meta.fullyCompiled, 'not fullyCompiled with an exception table');
  t.end();
});

test('structured wasm demotes unsupported blocks to exit stubs mid-loop', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'StructuredDemote', `
public class StructuredDemote {
  // the virtual call on a JRE class keeps slow unlinkable and uninlinable,
  // so drive's call block demotes to an exit stub; newarray alone no longer
  // demotes
  static int slow(int v) { return Integer.toString(v).length() + v; }
  public static int drive(int[] out, int n) {
    int sum = 0;
    for (int i = 0; i < n; i++) {
      sum = sum * 31 + i;
      if ((i & 63) == 0) sum += slow(i);
    }
    out[0] = sum;
    return sum;
  }
}
`);
  const n = 4000;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum = (Math.imul(sum, 31) + i) | 0;
    if ((i & 63) === 0) sum = (sum + String(i).length + i) | 0;
  }
  const out = [0];
  out.type = '[I';
  await invoke(jvm, thread, 'StructuredDemote', 'drive', '([II)I', [out, n]);
  t.equal(out[0], sum, 'result matches across repeated stub exits');
  t.ok(structuredKeys(jvm).includes('StructuredDemote.drive([II)I'),
    'compiled by the structured backend with a demoted call block');
  const method = await jvm.findMethodInHierarchy('StructuredDemote', 'drive', '([II)I');
  const st = jvm.jit.wasmJit.state.get(method);
  t.ok(st.meta.demoteReasons.size >= 1, 'the unlinkable call block is demoted');
  t.end();
});

test('structured wasm links invokestatic to a fully-compiled callee', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'StructuredLink', `
public class StructuredLink {
  static int mix(int a, int b) { int x = a * 0x9E3775 + b; x ^= x >>> 7; return x; }
  public static int drive(int[] out, int n) {
    int acc = 1;
    for (int i = 0; i < n; i++) acc = mix(acc, i);
    out[0] = acc;
    return acc;
  }
}
`);
  const n = 6000;
  let acc = 1;
  for (let i = 0; i < n; i++) {
    let x = (Math.imul(acc, 0x9E3775) + i) | 0;
    x = (x ^ (x >>> 7)) | 0;
    acc = x;
  }
  const out = [0];
  out.type = '[I';
  await invoke(jvm, thread, 'StructuredLink', 'drive', '([II)I', [out, n]);
  t.equal(out[0], acc, 'linked-callee loop matches reference');
  const method = await jvm.findMethodInHierarchy('StructuredLink', 'drive', '([II)I');
  const st = jvm.jit.wasmJit.state.get(method);
  t.ok(st && st.meta.structured, 'driver compiled structured');
  t.ok(st.meta.fullyCompiled, 'driver fully compiled (call bound in wasm)');
  t.equal(st.exits, 0, 'no exits: the loop stays in wasm across the calls');
  t.end();
});

test('structured wasm inlines small loop-free static callees', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'StructuredInline', `
public class StructuredInline {
  static int mask(int a, int b) { return a & b; }
  static int sel(int a, int b) { return a > b ? a - b : b - a; }
  public static int drive(int[] out, int n) {
    int acc = 1;
    for (int i = 0; i < n; i++) {
      acc = acc * 31 + mask(acc, i) + sel(i, acc & 255);
    }
    out[0] = acc;
    return acc;
  }
}
`);
  const n = 6000;
  let acc = 1;
  for (let i = 0; i < n; i++) {
    const m = acc & i;
    const b = acc & 255;
    const s = i > b ? i - b : b - i;
    acc = (Math.imul(acc, 31) + m + s) | 0;
  }
  const out = [0];
  out.type = '[I';
  await invoke(jvm, thread, 'StructuredInline', 'drive', '([II)I', [out, n]);
  t.equal(out[0], acc, 'inlined-callee loop matches reference');
  const method = await jvm.findMethodInHierarchy('StructuredInline', 'drive', '([II)I');
  const st = jvm.jit.wasmJit.state.get(method);
  t.ok(st && st.meta.structured, 'driver compiled structured');
  t.equal(st.meta.inlinedCalls, 2, 'both callees spliced into the caller');
  t.ok(st.meta.fullyCompiled, 'fully compiled with the calls dissolved');
  t.equal(st.exits, 0, 'no exits: no call boundary left to cross');
  // (mask/sel may still be compiled as callees by the dispatcher module
  // built alongside — the structured module itself has no call imports)
  t.end();
});

test('structured wasm fuel exhaustion spills and resumes correctly', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'StructuredFuel', `
public class StructuredFuel {
  public static long drive(long[] out, int n) {
    long acc = 0;
    for (int i = 0; i < n; i++) {
      acc += (long) (i ^ (i >>> 3));
    }
    out[0] = acc;
    return acc;
  }
}
`);
  // > FUEL iterations forces at least one fuel exit + interpreted resume
  const n = 5_400_000;
  let acc = 0n;
  for (let i = 0; i < n; i++) {
    acc += BigInt((i ^ (i >>> 3)) | 0);
  }
  const out = [0n];
  out.type = '[J';
  await invoke(jvm, thread, 'StructuredFuel', 'drive', '([JI)J', [out, n]);
  const method = await jvm.findMethodInHierarchy('StructuredFuel', 'drive', '([JI)J');
  const st = jvm.jit.wasmJit.state.get(method);
  t.ok(st && st.meta && st.meta.structured, 'compiled by the structured backend');
  t.ok(st.fuelExits >= 1 || st.exits >= 1, `took a transient exit (exits=${st.exits})`);
  t.equal(out[0], acc, 'sum across the fuel exit matches BigInt reference');
  t.end();
});

test('structured wasm compiles allocation ops without demotion', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'StructuredAlloc', `
public class StructuredAlloc {
  public static int drive(int[] out, int n) {
    int sum = 0;
    for (int i = 0; i < n; i++) {
      int[] a = new int[4];
      a[i & 3] = i;
      long[] w = new long[2];
      w[0] = (long) i * 3L;
      int[][] rows = new int[3][];
      rows[i % 3] = a;
      sum += a[i & 3] + (int) w[0] + rows[i % 3][i & 3];
    }
    out[0] = sum;
    return sum;
  }
}
`);
  const n = 3000;
  let sum = 0;
  for (let i = 0; i < n; i++) sum = (sum + 5 * i) | 0;
  const out = [0];
  out.type = '[I';
  await invoke(jvm, thread, 'StructuredAlloc', 'drive', '([II)I', [out, n]);
  t.equal(out[0], sum, 'allocation loop matches reference');
  t.ok(structuredKeys(jvm).includes('StructuredAlloc.drive([II)I'),
    'compiled by the structured backend');
  const method = await jvm.findMethodInHierarchy('StructuredAlloc', 'drive', '([II)I');
  const st = jvm.jit.wasmJit.state.get(method);
  t.equal(st.meta.demoteReasons.size, 0,
    `no demoted blocks (${[...st.meta.demoteReasons.values()].join(', ')})`);
  t.ok(st.meta.fullyCompiled, 'fully compiled: allocation never exits to the interpreter');
  t.end();
});

test('compiled newarray throws a catchable NegativeArraySizeException', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'StructuredNegSize', `
public class StructuredNegSize {
  static int alloc(int size) { int[] a = new int[size]; return a.length; }
  public static int warm(int n) {
    int sum = 0;
    for (int i = 0; i < n; i++) sum += alloc(3);
    return sum;
  }
  public static void neg(int[] out, int size) {
    try { out[0] = alloc(size); } catch (NegativeArraySizeException e) { out[0] = -7; }
  }
}
`);
  await invoke(jvm, thread, 'StructuredNegSize', 'warm', '(I)I', [500]);
  t.ok(jvm.jit.wasmJit.compiled.some((st) => st.key.startsWith('StructuredNegSize.alloc')),
    'alloc is compiled before the failing call');
  const out = [0];
  out.type = '[I';
  await invoke(jvm, thread, 'StructuredNegSize', 'neg', '([II)V', [out, -1]);
  t.equal(out[0], -7, 'guest catch saw NegativeArraySizeException from compiled code');
  await invoke(jvm, thread, 'StructuredNegSize', 'neg', '([II)V', [out, 6]);
  t.equal(out[0], 6, 'positive size still allocates');
  t.end();
});

test('structured wasm compiles live-handler-range blocks with EH', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'StructuredEh', `
public class StructuredEh {
  public static int drive(int[] out, int n) {
    int[] a = new int[8];
    int sum = 0;
    for (int i = 0; i < n; i++) {
      try {
        a[i & 15] = i;
        sum += a[i & 7];
      } catch (ArrayIndexOutOfBoundsException e) {
        sum += 1000;
      }
    }
    out[0] = sum;
    return sum;
  }
}
`);
  const n = 4000;
  const a = new Array(8).fill(0);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    if ((i & 15) < 8) {
      a[i & 15] = i;
      sum = (sum + a[i & 7]) | 0;
    } else {
      sum = (sum + 1000) | 0;
    }
  }
  const out = [0];
  out.type = '[I';
  await invoke(jvm, thread, 'StructuredEh', 'drive', '([II)I', [out, n]);
  t.equal(out[0], sum, 'recovering try/catch loop matches JS reference');
  t.ok(structuredKeys(jvm).includes('StructuredEh.drive([II)I'),
    'compiled by the structured backend');
  const method = await jvm.findMethodInHierarchy('StructuredEh', 'drive', '([II)I');
  const st = jvm.jit.wasmJit.state.get(method);
  const reasons = [...st.meta.demoteReasons.values()];
  t.notOk(reasons.includes('live handler range'),
    `no live-handler-range demotions (${reasons.join(', ') || 'none'})`);
  t.ok(st.meta.usedEh, 'EH catch sites were emitted');
  t.end();
});

test('EH spill delivers locals as of the throw point, not block entry', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'StructuredEhLocals', `
public class StructuredEhLocals {
  public static int drive(int[] out, int n) {
    int[] a = new int[8];
    int witness = -1;
    int sum = 0;
    for (int i = 0; i < n; i++) {
      try {
        witness = i * 2 + 1;
        sum += a[(i & 7) - 1];
      } catch (ArrayIndexOutOfBoundsException e) {
        sum += witness;
      }
    }
    out[0] = sum;
    return sum;
  }
}
`);
  const n = 4000;
  const a = new Array(8).fill(0);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const witness = i * 2 + 1;
    const idx = (i & 7) - 1;
    if (idx >= 0) sum = (sum + a[idx]) | 0;
    else sum = (sum + witness) | 0;
  }
  const out = [0];
  out.type = '[I';
  await invoke(jvm, thread, 'StructuredEhLocals', 'drive', '([II)I', [out, n]);
  t.equal(out[0], sum,
    'handler observed the local updated in the same block before the throw');
  const method = await jvm.findMethodInHierarchy('StructuredEhLocals', 'drive', '([II)I');
  const st = jvm.jit.wasmJit.state.get(method);
  t.ok(st.meta.usedEh, 'EH catch sites were emitted');
  t.end();
});

test('compiled athrow rethrow dispatches through nested guest handlers', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'StructuredEhThrow', `
public class StructuredEhThrow {
  public static int drive(int[] out, int n, RuntimeException boom) {
    int caught = 0;
    for (int i = 0; i < n; i++) {
      try {
        try {
          if ((i & 63) == 0) throw boom;
          caught += 1;
        } catch (RuntimeException e) {
          caught += 10;
          if ((i & 127) == 0) throw e;
        }
      } catch (RuntimeException e2) {
        caught += 100;
      }
    }
    out[0] = caught;
    return caught;
  }
}
`);
  const n = 4000;
  let caught = 0;
  for (let i = 0; i < n; i++) {
    if ((i & 63) === 0) caught += (i & 127) === 0 ? 110 : 10;
    else caught += 1;
  }
  caught |= 0;
  const out = [0];
  out.type = '[I';
  const boom = { type: 'java/lang/RuntimeException', fields: {}, hashCode: 991 };
  await invoke(jvm, thread, 'StructuredEhThrow', 'drive',
    '([IILjava/lang/RuntimeException;)I', [out, n, boom]);
  t.equal(out[0], caught, 'throw/rethrow chain matches JS reference');
  const method = await jvm.findMethodInHierarchy(
    'StructuredEhThrow', 'drive', '([IILjava/lang/RuntimeException;)I');
  const st = jvm.jit.wasmJit.state.get(method);
  const reasons = [...st.meta.demoteReasons.values()];
  t.notOk(reasons.includes('live handler range'),
    `no live-handler-range demotions (${reasons.join(', ') || 'none'})`);
  t.end();
});

test('structured tier compiles instance calls through linked callees', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'StructuredVCall', `
public class StructuredVCall {
  int acc;
  int step(int i) { return (i & 7) + 1; }
  private int twice(int i) { return i + i; }
  public int drive(int[] out, int n) {
    int sum = 0;
    for (int i = 0; i < n; i++) {
      sum += step(i);
      sum += twice(i & 3);
    }
    acc = sum;
    out[0] = sum;
    return sum;
  }
}
`);
  const n = 64;
  let ref = 0;
  for (let i = 0; i < n; i++) {
    ref = (ref + ((i & 7) + 1)) | 0;
    ref = (ref + 2 * (i & 3)) | 0;
  }
  const out = [0];
  out.type = '[I';
  const recv = { type: 'StructuredVCall', fields: {}, hashCode: 7 };
  for (let k = 0; k < 300; k++) {
    out[0] = 0;
    await invoke(jvm, thread, 'StructuredVCall', 'drive', '([II)I', [recv, out, n]);
    t.assert(out[0] === ref, `call ${k} matches`);
    if (out[0] !== ref) break;
  }
  t.ok(structuredKeys(jvm).includes('StructuredVCall.drive([II)I'),
    'caller compiled by the structured backend');
  const method = await jvm.findMethodInHierarchy('StructuredVCall', 'drive', '([II)I');
  const st = jvm.jit.wasmJit.state.get(method);
  const reasons = [...st.meta.demoteReasons.values()];
  t.notOk(reasons.some((r) => r.includes('invoke')),
    `no invoke demotions (${reasons.join(', ') || 'none'})`);
  t.ok(st.runs > 0, 'structured module executed');
  t.end();
});

test('structured call-site deopt resumes the interpreter mid-expression', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'StructuredPCall', `
public class StructuredPCall {
  static int shim(int i) {
    if ((i & 63) == 63) return "abc".length() + i;
    return i * 3;
  }
  int pick(int i) {
    if ((i & 127) == 127) return "x".length() + i;
    return (i & 7) + 1;
  }
  public int drive(int[] out, int n) {
    int sum = 0;
    for (int i = 0; i < n; i++) {
      sum += i + shim(i);
      sum += pick(i);
    }
    out[0] = sum;
    return sum;
  }
}
`);
  const n = 128;
  let ref = 0;
  for (let i = 0; i < n; i++) {
    ref = (ref + i + ((i & 63) === 63 ? 3 + i : i * 3)) | 0;
    ref = (ref + ((i & 127) === 127 ? 1 + i : (i & 7) + 1)) | 0;
  }
  const out = [0];
  out.type = '[I';
  const recv = { type: 'StructuredPCall', fields: {}, hashCode: 9 };
  let mismatches = 0;
  for (let k = 0; k < 300; k++) {
    out[0] = 0;
    await invoke(jvm, thread, 'StructuredPCall', 'drive', '([II)I', [recv, out, n]);
    if (out[0] !== ref) mismatches += 1;
  }
  t.equal(mismatches, 0, 'every call matches the JS reference');
  const method = await jvm.findMethodInHierarchy('StructuredPCall', 'drive', '([II)I');
  const st = jvm.jit.wasmJit.state.get(method);
  const reasons = [...st.meta.demoteReasons.values()];
  t.notOk(reasons.some((r) => r.includes('invoke')),
    `no invoke demotions in the caller (${reasons.join(', ') || 'none'})`);
  const shim = await jvm.findMethodInHierarchy('StructuredPCall', 'shim', '(I)I');
  const shimSt = jvm.jit.wasmJit.state.get(shim);
  t.ok(shimSt && shimSt.nestedCalls > 0, 'static callee ran nested');
  t.ok(shimSt && shimSt.nestedDeopts > 0, 'mid-method callee exit took the deopt path');
  const pick = await jvm.findMethodInHierarchy('StructuredPCall', 'pick', '(I)I');
  const pickSt = jvm.jit.wasmJit.state.get(pick);
  t.ok(pickSt && pickSt.nestedCalls > 0, 'instance callee ran nested');
  t.end();
});

test('guest exception from a nested callee dispatches through caller EH', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'StructuredVCallEh', `
public class StructuredVCallEh {
  int[] tab;
  int pick(int i) { return tab[(i & 15) - 1]; }
  public int drive(int[] out, int n) {
    int sum = 0;
    for (int i = 0; i < n; i++) {
      try { sum += pick(i); } catch (ArrayIndexOutOfBoundsException e) { sum += 7; }
    }
    out[0] = sum;
    return sum;
  }
}
`);
  const tab = [];
  tab.type = '[I';
  for (let j = 0; j < 15; j++) tab.push(j * j);
  const n = 64;
  let ref = 0;
  for (let i = 0; i < n; i++) {
    ref = (ref + ((i & 15) === 0 ? 7 : tab[(i & 15) - 1])) | 0;
  }
  const out = [0];
  out.type = '[I';
  const recv = { type: 'StructuredVCallEh', fields: { 'StructuredVCallEh.tab': tab }, hashCode: 11 };
  let mismatches = 0;
  for (let k = 0; k < 300; k++) {
    out[0] = 0;
    await invoke(jvm, thread, 'StructuredVCallEh', 'drive', '([II)I', [recv, out, n]);
    if (out[0] !== ref) mismatches += 1;
  }
  t.equal(mismatches, 0, 'every call matches the JS reference');
  const method = await jvm.findMethodInHierarchy('StructuredVCallEh', 'drive', '([II)I');
  const st = jvm.jit.wasmJit.state.get(method);
  t.ok(st.meta.usedEh, 'caller compiled with EH catch sites');
  const reasons = [...st.meta.demoteReasons.values()];
  t.notOk(reasons.some((r) => r.includes('invoke')),
    `no invoke demotions in the caller (${reasons.join(', ') || 'none'})`);
  t.ok(st.runs > 0, 'structured module executed');
  t.end();
});

test('dispatcher tier compiles live-handler-range blocks with EH', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'DispatchEh', `
public class DispatchEh {
  public static int drive(int[] out, int n) {
    int[] a = new int[8];
    int sum = 0;
    for (int i = 0; i < n; i++) {
      try {
        a[i & 15] = i;
        sum += a[i & 7];
      } catch (ArrayIndexOutOfBoundsException e) {
        sum += 1000;
      }
    }
    out[0] = sum;
    return sum;
  }
}
`, { JVM_WASM_STRUCTURED: '0' });
  const n = 4000;
  const a = new Array(8).fill(0);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    if ((i & 15) < 8) {
      a[i & 15] = i;
      sum = (sum + a[i & 7]) | 0;
    } else {
      sum = (sum + 1000) | 0;
    }
  }
  const out = [0];
  out.type = '[I';
  await invoke(jvm, thread, 'DispatchEh', 'drive', '([II)I', [out, n]);
  t.equal(out[0], sum, 'recovering try/catch loop matches JS reference');
  const method = await jvm.findMethodInHierarchy('DispatchEh', 'drive', '([II)I');
  const st = jvm.jit.wasmJit.state.get(method);
  t.ok(st && st.meta && !st.meta.structured, 'compiled by the dispatcher tier');
  const reasons = [...st.meta.demoteReasons.values()];
  t.notOk(reasons.includes('live handler range'),
    `no live-handler-range demotions (${reasons.join(', ') || 'none'})`);
  t.ok(st.meta.usedEh, 'module carries the EH flag');
  // ~2000 of the 4000 iterations throw; in-module handler dispatch keeps
  // them inside wasm, so exits stay far below the throw count
  t.ok(st.exits < 100,
    `throws dispatch to the compiled handler in-module (exits=${st.exits})`);
  t.end();
});

test('nested EH callee dispatches its own handler without leaving the caller', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'NestedEhCallee', `
public class NestedEhCallee {
  int[] tab = null;
  int risky(int i) {
    try {
      return tab[i & 7];
    } catch (NullPointerException e) {
      return 5;
    }
  }
  public int drive(int[] out, int n) {
    int sum = 0;
    for (int i = 0; i < n; i++) sum += risky(i) + (i & 1);
    out[0] = sum;
    return sum;
  }
}
`);
  // tab stays null: every risky() call throws NPE internally and recovers to 5
  const n = 64;
  let ref = 0;
  for (let i = 0; i < n; i++) ref = (ref + 5 + (i & 1)) | 0;
  const out = [0];
  out.type = '[I';
  const recv = { type: 'NestedEhCallee', fields: { 'NestedEhCallee.tab': null }, hashCode: 13 };
  let mismatches = 0;
  for (let k = 0; k < 300; k++) {
    out[0] = 0;
    await invoke(jvm, thread, 'NestedEhCallee', 'drive', '([II)I', [recv, out, n]);
    if (out[0] !== ref) mismatches += 1;
  }
  t.equal(mismatches, 0, 'every call matches the JS reference');
  const risky = await jvm.findMethodInHierarchy('NestedEhCallee', 'risky', '(I)I');
  const riskySt = jvm.jit.wasmJit.state.get(risky);
  t.ok(riskySt && riskySt.meta && riskySt.meta.usedEh, 'callee is an EH module');
  t.ok(riskySt && riskySt.nestedCalls > 0, 'EH callee ran nested');
  t.end();
});

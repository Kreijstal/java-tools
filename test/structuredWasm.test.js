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

async function makeHarness(t, className, source) {
  withEnv(t, { JVM_WASM_JIT: '1', JVM_WASM_STRUCTURED: '1' });
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

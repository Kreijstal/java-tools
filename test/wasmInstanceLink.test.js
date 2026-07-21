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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instance-link-fixture-'));
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
  withEnv(t, { JVM_WASM_JIT: '1', JVM_WASM_CHECKCAST: '1' });
  const classpath = compileJavaFixture(t, className, source);
  const jvm = new JVM({ classpath, jit: { warmupThreshold: 100 } });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const thread = {
    id: 0,
    name: 'instance-link-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  return { jvm, thread };
}

function stateOf(jvm, key) {
  return jvm.jit.wasmJit.compiled.find((st) => st.key === key) || null;
}

const FIXTURE = `
public class InstanceLink {
  public static int drive(int[] out, int n) {
    Shape a = new ShapeA();
    Shape b = new ShapeB();
    int sum = 0;
    for (int i = 0; i < n; i++) {
      Shape s;
      if ((i & 1) == 0) { s = a; } else { s = b; }
      int r = s.mul(sum + i);
      sum = (sum + r) & 0xfffff;
    }
    out[0] = sum;
    return sum;
  }
  public static int driveAccum(int[] out, int n) {
    Shape a = new ShapeA();
    Shape b = new ShapeB();
    int sum = 0;
    for (int i = 0; i < n; i++) {
      Shape s;
      if ((i & 1) == 0) { s = a; } else { s = b; }
      sum = (sum + s.mul(sum + i)) & 0xfffff;
    }
    out[0] = sum;
    return sum;
  }
  public static int driveCast(int[] out, int n) {
    Object a = new ShapeA();
    Object b = new ShapeB();
    int sum = 0;
    for (int i = 0; i < n; i++) {
      Object o;
      if ((i & 1) == 0) { o = a; } else { o = b; }
      Shape s = (Shape) o;
      sum = (sum + s.mul(sum + i)) & 0xfffff;
    }
    out[0] = sum;
    return sum;
  }
  public static void plantA() { Holder.c = new ShapeA(); }
  public static void plantC() { Holder.c = new ShapeC(); }
  public static int driveMixed(int[] out, int n) {
    Shape a = new ShapeA();
    Shape c = Holder.c;
    int sum = 0;
    for (int i = 0; i < n; i++) {
      Shape s;
      if ((i & 1) == 0) { s = a; } else { s = c; }
      int r = s.mul(sum + i);
      sum = (sum + r) & 0xfffff;
    }
    out[0] = sum;
    return sum;
  }
  public static int driveSuper(int[] out, int n) {
    Sub2 s = new Sub2();
    int sum = 0;
    for (int i = 0; i < n; i++) {
      int r = s.g(sum + i);
      sum = (sum + r) & 0xfffff;
    }
    out[0] = sum;
    return sum;
  }
  public static int inner(Shape s, int n) {
    int sum = 0;
    for (int i = 0; i < n; i++) {
      int r = s.mul(i);
      sum = (sum + r) & 0xfffff;
    }
    return sum;
  }
  public static void nullProbe(int[] out, Shape s, int n) {
    try {
      out[0] = inner(s, n);
    } catch (NullPointerException e) {
      out[0] = -42;
    }
  }
}
abstract class Shape { abstract int mul(int v); }
class ShapeA extends Shape { int mul(int v) { return (v & 0xffff) * 3; } }
class ShapeB extends Shape { int mul(int v) { return (v ^ 31) + 1; } }
class ShapeC extends Shape { int mul(int v) { return v - 7; } }
class Holder { static Shape c; }
class Sup2 { int g(int v) { return (v & 0xffff) * 3 + 1; } }
class Sub2 extends Sup2 { int g(int v) { return super.g(v) ^ 5; } }
`;

const mulA = (v) => ((v & 0xffff) * 3) | 0;
const mulB = (v) => ((v ^ 31) + 1) | 0;
const mulC = (v) => (v - 7) | 0;

function referenceDrive(n, mulEven, mulOdd) {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const r = (i & 1) === 0 ? mulEven((sum + i) | 0) : mulOdd((sum + i) | 0);
    sum = ((sum + r) | 0) & 0xfffff;
  }
  return sum;
}

test('polymorphic invokevirtual links through a closed-world dispatch table', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'InstanceLink', FIXTURE);
  const n = 6000;
  const expected = referenceDrive(n, mulA, mulB);
  const out = [0];
  out.type = '[I';
  for (let round = 0; round < 3; round += 1) {
    await invoke(jvm, thread, 'InstanceLink', 'drive', '([II)I', [out, n]);
    t.equal(out[0], expected, `round ${round} matches the JS reference`);
  }
  const st = stateOf(jvm, 'InstanceLink.drive([II)I');
  t.ok(st, 'drive compiled to wasm');
  t.ok(st.meta.deoptableCalls >= 1, 'the invokevirtual site linked as an instance call');
  t.ok(st.runs > 0, 'compiled module actually ran');
  t.equal(jvm.jit.wasmJit.compiled.some((s) => s.key === 'ShapeA.mul(I)I' ||
    s.key === 'ShapeB.mul(I)I'), true, 'at least one target compiled as callee');
  t.end();
});

test('an instance call with values under its arguments still links', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'InstanceLink', FIXTURE);
  const n = 6000;
  const expected = referenceDrive(n, mulA, mulB);
  const out = [0];
  out.type = '[I';
  for (let round = 0; round < 3; round += 1) {
    await invoke(jvm, thread, 'InstanceLink', 'driveAccum', '([II)I', [out, n]);
    t.equal(out[0], expected, `round ${round} matches the JS reference`);
  }
  const st = stateOf(jvm, 'InstanceLink.driveAccum([II)I');
  t.ok(st, 'driveAccum compiled to wasm');
  t.ok(st.meta.deoptableCalls >= 1, 'the under-stack site linked as an instance call');
  t.ok(st.runs > 0, 'compiled module actually ran');
  t.end();
});

test('checkcast compiles as a guarded import inside the loop', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'InstanceLink', FIXTURE);
  const n = 6000;
  const expected = referenceDrive(n, mulA, mulB);
  const out = [0];
  out.type = '[I';
  for (let round = 0; round < 3; round += 1) {
    await invoke(jvm, thread, 'InstanceLink', 'driveCast', '([II)I', [out, n]);
    t.equal(out[0], expected, `round ${round} matches the JS reference`);
  }
  const st = stateOf(jvm, 'InstanceLink.driveCast([II)I');
  t.ok(st, 'driveCast compiled to wasm');
  t.ok(st.runs > 0, 'compiled module actually ran');
  t.notOk([...st.meta.demoteReasons.values()].some((r) => /checkcast/.test(r)),
    'no block was demoted for checkcast');
  t.end();
});

test('a class loaded after compilation misses the map and deopts correctly', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'InstanceLink', FIXTURE);
  const n = 4000;
  const out = [0];
  out.type = '[I';
  await invoke(jvm, thread, 'InstanceLink', 'plantA', '()V', []);
  const expectedAA = referenceDrive(n, mulA, mulA);
  for (let round = 0; round < 3; round += 1) {
    await invoke(jvm, thread, 'InstanceLink', 'driveMixed', '([II)I', [out, n]);
    t.equal(out[0], expectedAA, `warm round ${round} (ShapeA twice) matches`);
  }
  const st = stateOf(jvm, 'InstanceLink.driveMixed([II)I');
  t.ok(st && st.meta.deoptableCalls >= 1, 'driveMixed linked its instance site');
  t.notOk(Object.prototype.hasOwnProperty.call(jvm.classes, 'ShapeC'),
    'ShapeC is not loaded before plantC');
  const exitsBefore = st ? st.exits : 0;
  await invoke(jvm, thread, 'InstanceLink', 'plantC', '()V', []);
  t.ok(Object.prototype.hasOwnProperty.call(jvm.classes, 'ShapeC'),
    'plantC loaded ShapeC after driveMixed compiled');
  const expectedAC = referenceDrive(n, mulA, mulC);
  await invoke(jvm, thread, 'InstanceLink', 'driveMixed', '([II)I', [out, n]);
  t.equal(out[0], expectedAC, 'post-load round dispatches ShapeC correctly');
  if (st) {
    t.ok(st.exits > exitsBefore, 'the unseen class took the miss-deopt path');
  }
  t.end();
});

test('invokespecial super call links statically', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'InstanceLink', FIXTURE);
  const n = 6000;
  const gSub = (v) => ((((v & 0xffff) * 3 + 1) | 0) ^ 5) | 0;
  let expected = 0;
  for (let i = 0; i < n; i++) {
    const r = gSub((expected + i) | 0);
    expected = ((expected + r) | 0) & 0xfffff;
  }
  const out = [0];
  out.type = '[I';
  for (let round = 0; round < 3; round += 1) {
    await invoke(jvm, thread, 'InstanceLink', 'driveSuper', '([II)I', [out, n]);
    t.equal(out[0], expected, `round ${round} matches the JS reference`);
  }
  const sub = stateOf(jvm, 'Sub2.g(I)I');
  t.ok(sub, 'Sub2.g compiled as a callee');
  t.ok(sub && sub.meta.deoptableCalls >= 1, 'Sub2.g linked its super call');
  t.end();
});

test('null receiver throws the guest NPE from compiled code', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'InstanceLink', FIXTURE);
  const n = 6000;
  const out = [0];
  out.type = '[I';
  const shapeA = { type: 'ShapeA', fields: {} };
  await invoke(jvm, thread, 'InstanceLink', 'plantA', '()V', []);
  let expected = 0;
  for (let i = 0; i < n; i++) expected = ((expected + mulA(i)) | 0) & 0xfffff;
  await invoke(jvm, thread, 'InstanceLink', 'nullProbe', '([ILShape;I)V', [out, shapeA, n]);
  t.equal(out[0], expected, 'non-null receiver computes normally');
  const st = stateOf(jvm, 'InstanceLink.inner(LShape;I)I');
  t.ok(st && st.meta.deoptableCalls >= 1, 'inner linked its instance site');
  await invoke(jvm, thread, 'InstanceLink', 'nullProbe', '([ILShape;I)V', [out, null, n]);
  t.equal(out[0], -42, 'null receiver surfaced as a catchable guest NPE');
  t.end();
});

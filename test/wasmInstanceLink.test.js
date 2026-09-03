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

async function makeHarness(t, className, source, extraEnv = {}) {
  withEnv(t, {
    JVM_WASM_JIT: '1',
    JVM_WASM_CHECKCAST: '1',
    JVM_DISABLE_WASM_LATE_INSTANCE_TARGETS: '0',
    ...extraEnv,
  });
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
  public static int driveParam(int[] out, Shape s, int n) {
    int sum = 0;
    for (int i = 0; i < n; i++) {
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
  public static void plantD() { Holder.c = new ShapeD(); }
  public static int driveMixed(int[] out, int n) {
    Shape a = new ShapeA();
    Shape c = Holder.c;
    int writesBefore = Holder.writes;
    int sum = 0;
    for (int i = 0; i < n; i++) {
      Shape s;
      if ((i & 1) == 0) { s = a; } else { s = c; }
      int r = s.mul(sum + i);
      sum = (sum + r) & 0xfffff;
    }
    out[0] = sum;
    out[1] = Holder.writes - writesBefore;
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
class ShapeD extends Shape {
  int mul(int v) { Holder.writes++; return v + 11; }
}
class Holder { static Shape c; static int writes; }
class Sup2 { int g(int v) { return (v & 0xffff) * 3 + 1; } }
class Sub2 extends Sup2 { int g(int v) { return super.g(v) ^ 5; } }
`;

const mulA = (v) => ((v & 0xffff) * 3) | 0;
const mulB = (v) => ((v ^ 31) + 1) | 0;
const mulC = (v) => (v - 7) | 0;
const mulD = (v) => (v + 11) | 0;

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

test('a pure target loaded after compilation installs without deoptimizing', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'InstanceLink', FIXTURE);
  const n = 4000;
  const out = [0, 0];
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
  t.equal(out[1], 0, 'pure late target leaves caller-visible writes unchanged');
  if (st) {
    t.equal(st.exits, exitsBefore, 'late target continued without exiting the caller');
  }
  t.ok(jvm.jit.wasmJit.lateInstanceTargetInstalls >= 1,
    'the call-site map recorded a late target installation');
  // The dependency-driven rebuild must defer to late installation. Loading
  // ShapeC advances the class epoch, which is the rebuild's trigger condition,
  // but this module is being served without exiting, so rebuilding it would
  // throw away a working module and lose the install above.
  t.notOk(st && st.depRecompiles,
    'a module served by late installation is not rebuilt');
  t.end();
});

test('late target with uncovered writes retains the safe deopt path', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'InstanceLink', FIXTURE);
  const n = 4000;
  const out = [0, 0];
  out.type = '[I';
  await invoke(jvm, thread, 'InstanceLink', 'plantA', '()V', []);
  for (let round = 0; round < 3; round += 1) {
    await invoke(jvm, thread, 'InstanceLink', 'driveMixed', '([II)I', [out, n]);
  }
  const st = stateOf(jvm, 'InstanceLink.driveMixed([II)I');
  const exitsBefore = st ? st.exits : 0;
  await invoke(jvm, thread, 'InstanceLink', 'plantD', '()V', []);
  await invoke(jvm, thread, 'InstanceLink', 'driveMixed', '([II)I', [out, n]);
  t.equal(out[0], referenceDrive(n, mulA, mulD), 'stateful late target computes correctly');
  t.equal(out[1], n >> 1, 'every target write remains visible across the call loop');
  if (st) t.ok(st.exits > exitsBefore, 'uncovered writes force a pre-side-effect deopt');
  t.ok(jvm.jit.wasmJit.lateInstanceTargetWriteRejects >= 1,
    'write-summary guard rejected unsafe installation');
  t.end();
});

test('late-target kill switch retains map-miss deoptimization', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'InstanceLink', FIXTURE, {
    JVM_DISABLE_WASM_LATE_INSTANCE_TARGETS: '1',
  });
  const n = 4000;
  const out = [0, 0];
  out.type = '[I';
  await invoke(jvm, thread, 'InstanceLink', 'plantA', '()V', []);
  for (let round = 0; round < 3; round += 1) {
    await invoke(jvm, thread, 'InstanceLink', 'driveMixed', '([II)I', [out, n]);
  }
  const st = stateOf(jvm, 'InstanceLink.driveMixed([II)I');
  const exitsBefore = st ? st.exits : 0;
  await invoke(jvm, thread, 'InstanceLink', 'plantC', '()V', []);
  await invoke(jvm, thread, 'InstanceLink', 'driveMixed', '([II)I', [out, n]);
  t.equal(out[0], referenceDrive(n, mulA, mulC), 'disabled path remains correct');
  if (st) t.ok(st.exits > exitsBefore, 'disabled path deoptimizes on the unseen receiver');
  t.equal(jvm.jit.wasmJit.lateInstanceTargetInstalls, 0, 'kill switch installs no targets');
  t.end();
});

test('structured call import installs a pure late target', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'InstanceLink', FIXTURE, {
    JVM_WASM_STRUCTURED: '1',
    JVM_WASM_INSTANCE_INLINE: '0',
  });
  const n = 4000;
  const out = [0];
  out.type = '[I';
  await jvm.loadClassByName('Shape');
  jvm.classInitializationState.set('Shape', 'INITIALIZED');
  await jvm.loadClassByName('ShapeA');
  jvm.classInitializationState.set('ShapeA', 'INITIALIZED');
  const shapeA = { type: 'ShapeA', fields: {} };
  for (let round = 0; round < 3; round += 1) {
    await invoke(jvm, thread, 'InstanceLink', 'driveParam', '([ILShape;I)I', [out, shapeA, n]);
  }
  const st = stateOf(jvm, 'InstanceLink.driveParam([ILShape;I)I');
  t.ok(st && st.meta.structured, 'driveParam uses the structured call import');
  const exitsBefore = st ? st.exits : 0;
  await jvm.loadClassByName('ShapeC');
  jvm.classInitializationState.set('ShapeC', 'INITIALIZED');
  const shapeC = { type: 'ShapeC', fields: {} };
  await invoke(jvm, thread, 'InstanceLink', 'driveParam', '([ILShape;I)I', [out, shapeC, n]);
  t.equal(out[0], referenceDrive(n, mulC, mulC), 'structured late target computes correctly');
  if (st) t.equal(st.exits, exitsBefore, 'structured caller stays in wasm');
  t.ok(jvm.jit.wasmJit.lateInstanceTargetInstalls >= 1,
    'structured import recorded a late target installation');
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

const MONO_SOURCE = `
public class MonoLink {
  public static int drive(int[] out, Gear g, int n) {
    int s = 0;
    for (int i = 0; i < n; i++) s = (s + g.spin(s + i)) & 0xfffff;
    out[0] = s;
    return s;
  }
}
class Gear { int k; int spin(int v) { return (v * 3) ^ k; } }
class GearSub extends Gear { int spin(int v) { return v + 1000; } }
`;

function referenceMono(n, k, spin) {
  let s = 0;
  for (let i = 0; i < n; i += 1) s = ((s + spin((s + i) | 0, k)) | 0) & 0xfffff;
  return s;
}
const spinGear = (v, k) => (Math.imul(v, 3) ^ k) | 0;
const spinSub = (v) => (v + 1000) | 0;

test('complete monomorphic cone links with only a null check and survives a later overrider', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'MonoLink', MONO_SOURCE, {
    JVM_WASM_DIRECT_INSTANCE_LINK: '1',
  });
  await jvm.loadClassByName('Gear');
  jvm.classInitializationState.set('Gear', 'INITIALIZED');
  const n = 6000;
  const out = [0];
  out.type = '[I';
  const gear = { type: 'Gear', fields: { 'Gear.k': 5 } };
  for (let round = 0; round < 3; round += 1) {
    await invoke(jvm, thread, 'MonoLink', 'drive', '([ILGear;I)I', [out, gear, n]);
    t.equal(out[0], referenceMono(n, 5, spinGear), `round ${round} matches`);
  }
  const st = stateOf(jvm, 'MonoLink.drive([ILGear;I)I');
  t.ok(st, 'drive compiled to wasm');
  t.ok(st.meta.directLinks >= 1, 'the site raw-linked');
  const monoSites = (st.meta.specSites || []).filter((s) => s.name === 'spin');
  t.ok(monoSites.length >= 1, 'the mono link recorded a caller speculation');
  t.same(monoSites[0].guards, ['Gear'], 'speculation guards the single impl');
  t.ok(st.meta.specok, 'module exports the specok flag');
  t.equal(st.meta.specok.value, 1, 'specok armed while the world matches');

  // Loading an overriding subclass must drop specok synchronously so a
  // mid-run receiver could not take the stale fast path, and the next entry
  // must revalidate, invalidate, and recompile with correct dispatch.
  const staleSpecok = st.meta.specok;
  await jvm.loadClassByName('GearSub');
  jvm.classInitializationState.set('GearSub', 'INITIALIZED');
  t.equal(staleSpecok.value, 0, 'class load zeroes the in-wasm flag');
  const sub = { type: 'GearSub', fields: { 'Gear.k': 5 } };
  await invoke(jvm, thread, 'MonoLink', 'drive', '([ILGear;I)I', [out, sub, n]);
  t.equal(out[0], referenceMono(n, 5, (v) => spinSub(v)),
    'GearSub receiver dispatches the override after the world grew');
  await invoke(jvm, thread, 'MonoLink', 'drive', '([ILGear;I)I', [out, gear, n]);
  t.equal(out[0], referenceMono(n, 5, spinGear), 'Gear receiver still correct');
  t.end();
});

const CTOR_SOURCE = `
public class CtorLink {
  public static int drive(int[] out, int n) {
    int s = 0;
    for (int i = 0; i < n; i++) {
      Box b = new Box(i, s);
      s = (s + b.a * 3 + b.b) & 0xfffff;
    }
    out[0] = s;
    return s;
  }
}
class Box { int a; int b; Box(int a, int b) { this.a = a; this.b = b + 1; } }
`;

function referenceCtor(n) {
  let s = 0;
  for (let i = 0; i < n; i += 1) {
    const a = i; const b = (s + 1) | 0;
    s = ((s + Math.imul(a, 3) + b) | 0) & 0xfffff;
  }
  return s;
}

test('invokespecial <init> links to a fully compiled constructor', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'CtorLink', CTOR_SOURCE, {
    JVM_WASM_DIRECT_INSTANCE_LINK: '1',
  });
  await jvm.loadClassByName('Box');
  jvm.classInitializationState.set('Box', 'INITIALIZED');
  const n = 6000;
  const out = [0];
  out.type = '[I';
  for (let round = 0; round < 3; round += 1) {
    await invoke(jvm, thread, 'CtorLink', 'drive', '([II)I', [out, n]);
    t.equal(out[0], referenceCtor(n),
      `round ${round}: constructed fields read back correctly`);
  }
  const st = stateOf(jvm, 'CtorLink.drive([II)I');
  t.ok(st, 'drive compiled to wasm');
  t.notOk([...st.meta.demoteReasons.values()].some((r) => /<init>/.test(r)),
    'the constructor call no longer demotes the caller');
  t.ok(st.meta.fullyCompiled, 'the caller compiles fully around the new+<init>');
  t.end();
});

const CTOR_PARTIAL_SOURCE = `
public class CtorPartial {
  public static int drive(int[] out, int n) {
    int s = 0;
    for (int i = 0; i < n; i++) {
      Wild w = new Wild(i);
      s = (s + w.v) & 0xfffff;
    }
    out[0] = s;
    return s;
  }
}
class Wild {
  int v;
  Wild(int i) {
    if (i < 0) throw new RuntimeException("never");
    this.v = (i * 7) ^ 3;
  }
}
`;

function referenceWild(n) {
  let s = 0;
  for (let i = 0; i < n; i += 1) s = ((s + (Math.imul(i, 7) ^ 3)) | 0) & 0xfffff;
  return s;
}

test('a constructor that cannot fully compile refuses the link and stays correct', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'CtorPartial', CTOR_PARTIAL_SOURCE, {
    JVM_WASM_DIRECT_INSTANCE_LINK: '1',
  });
  await jvm.loadClassByName('Wild');
  jvm.classInitializationState.set('Wild', 'INITIALIZED');
  const n = 6000;
  const out = [0];
  out.type = '[I';
  for (let round = 0; round < 3; round += 1) {
    await invoke(jvm, thread, 'CtorPartial', 'drive', '([II)I', [out, n]);
    t.equal(out[0], referenceWild(n),
      `round ${round}: partial-ctor path stays correct`);
  }
  t.end();
});

test('a deferred callee is retried only when its blockers move or after backoff', (t) => {
  const WasmJit = require('../src/jit/WasmJit');
  const readyKeys = new Set();
  const jit = {
    compileEpoch: 10,
    retryBackoffMax: 8,
    blockerSignature: (blockers) => blockers.map((b) => (readyKeys.has(b) ? '2' : '0')).join(''),
    calleeRetryAllowed: WasmJit.prototype.calleeRetryAllowed,
    blockersResolved: WasmJit.prototype.blockersResolved,
  };
  // Never deferred: always eligible.
  t.ok(jit.calleeRetryAllowed({}), 'fresh callee compiles');
  // Deferred this epoch: never retried in the same epoch.
  const named = { calleeDeferredEpoch: 10, calleeBlockers: ['x.y(I)V'], calleeBlockerSig: '0', calleeRetryEpoch: 18 };
  t.notOk(jit.calleeRetryAllowed(named), 'same epoch: no retry');
  jit.compileEpoch = 11;
  t.notOk(jit.calleeRetryAllowed(named), 'epoch moved but blocker did not and backoff not reached: no retry');
  readyKeys.add('x.y(I)V');
  t.ok(jit.calleeRetryAllowed(named), 'blocker became ready: immediate retry');
  readyKeys.delete('x.y(I)V');
  jit.compileEpoch = 18;
  t.ok(jit.calleeRetryAllowed(named), 'backoff epoch reached without blocker movement: retry');
  // No named blockers: exponential epoch backoff.
  const anon = { calleeDeferredEpoch: 11, calleeBlockers: null, calleeRetryEpoch: 11 + 4 };
  jit.compileEpoch = 12;
  t.notOk(jit.calleeRetryAllowed(anon), 'before backoff epoch: no retry');
  jit.compileEpoch = 15;
  t.ok(jit.calleeRetryAllowed(anon), 'at backoff epoch: retry');
  t.end();
});

test('a call dependency retains the deferred callee root cause', (t) => {
  const WasmJit = require('../src/jit/WasmJit');
  const method = {
    name: 'make',
    descriptor: '()Ljava/lang/Object;',
    flags: ['static'],
  };
  const state = new WeakMap([[method, {
    status: 'cold',
    calleeBlockers: ['example/Allocated'],
  }]]);
  const jit = {
    jvm: {
      classes: {
        'example/Factory': {
          ast: {classes: [{items: [
            {type: 'method', method},
            {type: 'method', method: {name: '<clinit>', descriptor: '()V'}},
          ]}]},
        },
      },
      classInitializationState: new Map([
        ['example/Factory', 'INITIALIZED'],
      ]),
    },
    state,
  };
  const blockers = WasmJit.prototype.methodLinkBlockers.call(
    jit, 'example/Factory', 'make', '()Ljava/lang/Object;');
  t.deepEqual(blockers, [
    'example/Factory.make()Ljava/lang/Object;',
    'example/Allocated',
  ], 'the method identity and its concrete class dependency are both retained');
  t.end();
});

const CONFLICT_SLOT_FIXTURE = `
public class ConflictSlotLink {
  static final class Scaler {
    int mul(int x) {
      int r;
      { int k = x * 3; r = k + 1; }
      if (r < 0) return 0;
      try { float f = r * 0.5f; r = (int) f; } catch (RuntimeException e) { r = -1; }
      return r & 0xffff;
    }
  }
  public static int drive(int[] out, int n) {
    Scaler s = new Scaler();
    int sum = 0;
    for (int i = 0; i < n; i++) {
      sum = (sum + s.mul(sum + i)) & 0xfffff;
    }
    out[0] = sum;
    return sum;
  }
}
`;

function referenceConflictDrive(n) {
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    let r = ((sum + i) * 3 + 1) | 0;
    r = r < 0 ? 0 : Math.trunc(Math.fround(r * 0.5)) & 0xffff;
    sum = (sum + r) & 0xfffff;
  }
  return sum;
}

test('a callee whose dispatcher module boxes a reused slot still links through its structured module', async (t) => {
  // javac gives the block-scoped int and float the same slot. The dispatcher
  // lowering boxes such a slot (frame imports), which no link site accepts;
  // the structured lowering types it through SSA and stays linkable. The
  // callee-module choice must not hand the boxed module to the linker just
  // because it covers the handler block the structured module leaves out.
  const { jvm, thread } = await makeHarness(t, 'ConflictSlotLink', CONFLICT_SLOT_FIXTURE, {
    JVM_WASM_STRUCTURED: '1',
    JVM_WASM_INSTANCE_INLINE: '0',
  });
  await jvm.loadClassByName('ConflictSlotLink$Scaler');
  jvm.classInitializationState.set('ConflictSlotLink$Scaler', 'INITIALIZED');
  const n = 6000;
  const expected = referenceConflictDrive(n);
  const out = [0];
  out.type = '[I';
  for (let round = 0; round < 3; round += 1) {
    await invoke(jvm, thread, 'ConflictSlotLink', 'drive', '([II)I', [out, n]);
    t.equal(out[0], expected, `round ${round} matches the JS reference`);
  }
  const callee = stateOf(jvm, 'ConflictSlotLink$Scaler.mul(I)I');
  t.ok(callee, 'mul compiled as a callee');
  const linkedMeta = callee && (callee.callee || callee).meta;
  t.equal(linkedMeta && linkedMeta.boxedCount, 0, 'the module offered to links has no boxed slot');
  t.ok(jvm.jit.wasmJit.findReadyInstance('ConflictSlotLink$Scaler', 'mul', '(I)I'),
    'mul is linkable');
  const caller = stateOf(jvm, 'ConflictSlotLink.drive([II)I');
  t.ok(caller, 'drive compiled to wasm');
  t.ok(caller.meta.deoptableCalls >= 1, 'the invokevirtual site linked as an instance call');
  t.equal([...(caller.meta.demoteReasons || new Map()).values()]
    .filter((reason) => /no ready impl|not ready/.test(reason)).length, 0,
  'drive did not demote the call for a missing callee');
  t.end();
});

const SELF_RECURSIVE_FIXTURE = `
public class SelfLink {
  static final class Sorter {
    final int[] keys;
    Sorter(int n) {
      keys = new int[n];
      for (int i = 0; i < n; i++) keys[i] = (i * 7919 + 13) % 101;
    }
    private void sort(int lo, int hi) {
      if (lo >= hi) return;
      int pivot = keys[(lo + hi) >>> 1];
      int i = lo;
      int j = hi;
      while (i <= j) {
        while (keys[i] < pivot) i++;
        while (keys[j] > pivot) j--;
        if (i <= j) {
          int t = keys[i]; keys[i] = keys[j]; keys[j] = t;
          i++; j--;
        }
      }
      sort(lo, j);
      sort(i, hi);
    }
    int checksum() {
      int sum = 0;
      for (int i = 0; i < keys.length; i++) sum = (sum * 31 + keys[i]) & 0xfffff;
      return sum;
    }
  }
  public static int drive(int[] out, int rounds) {
    int sum = 0;
    for (int r = 0; r < rounds; r++) {
      Sorter s = new Sorter(64);
      s.sort(0, 63);
      sum = (sum + s.checksum()) & 0xfffff;
    }
    out[0] = sum;
    return sum;
  }
}
`;

function referenceSelfDrive(rounds) {
  let sum = 0;
  for (let r = 0; r < rounds; r += 1) {
    const keys = [];
    for (let i = 0; i < 64; i += 1) keys.push((i * 7919 + 13) % 101);
    keys.sort((a, b) => a - b);
    let check = 0;
    for (let i = 0; i < keys.length; i += 1) check = (Math.imul(check, 31) + keys[i]) & 0xfffff;
    sum = (sum + check) & 0xfffff;
  }
  return sum;
}

test('a self-recursive instance method links its own call and stays in wasm', async (t) => {
  // While sort is being compiled its own state is not ready, so the
  // recursive call used to demote its block and the finished module exited
  // at that call on every invocation. The site now links to the method's own
  // state, which the import resolves at call time.
  const { jvm, thread } = await makeHarness(t, 'SelfLink', SELF_RECURSIVE_FIXTURE, {
    JVM_WASM_STRUCTURED: '1',
    JVM_WASM_INSTANCE_INLINE: '0',
  });
  await jvm.loadClassByName('SelfLink$Sorter');
  jvm.classInitializationState.set('SelfLink$Sorter', 'INITIALIZED');
  const rounds = 400;
  const expected = referenceSelfDrive(rounds);
  const out = [0];
  out.type = '[I';
  for (let round = 0; round < 3; round += 1) {
    await invoke(jvm, thread, 'SelfLink', 'drive', '([II)I', [out, rounds]);
    t.equal(out[0], expected, `round ${round} matches the JS reference`);
  }
  const sorter = stateOf(jvm, 'SelfLink$Sorter.sort(II)V');
  t.ok(sorter, 'sort compiled to wasm');
  const sorterMeta = sorter && (sorter.callee || sorter).meta;
  t.ok(sorterMeta && sorterMeta.normalFlowFullyCompiled,
    'the recursive call did not demote a normal-flow block');
  t.equal([...((sorterMeta && sorterMeta.demoteReasons) || new Map()).values()]
    .filter((reason) => /not ready|no ready impl/.test(reason)).length, 0,
  'no block waits on the method itself');
  t.equal(sorter.nestedDeopts || 0, 0, 'no recursive call exited the module');
  t.end();
});

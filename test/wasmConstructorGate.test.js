'use strict';

// docs/refactor.md 3.3: "Constructor compilation once allocation follows the
// managed-heap protocol. Audit the existing `ctor-or-clinit` exclusion without
// conflating ordinary constructors with class-initialization ordering and side
// effects."
//
// The audit's conclusion, pinned here as tests: <clinit> stays excluded
// unconditionally, an ordinary <init> becomes a candidate behind a flag, and
// the shapes that could actually make a compiled constructor unsound -- a
// throw part-way through, superclass ordering, and field values observed by a
// later reader -- keep producing exactly the interpreter's answers.

const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');

function compileJavaFixture(t, className, source) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctorgate-fixture-'));
  t.teardown(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tempDir, `${className}.java`), source);
  execFileSync('javac', ['-g', '-d', tempDir, path.join(tempDir, `${className}.java`)],
    { stdio: 'inherit' });
  return tempDir;
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

const SOURCE = `
public class CtorGate {
  static class Base {
    int b0, b1;
    Base(int seed) {
      // A loop inside the superclass constructor, so the compiled body has
      // something to cover and the ordering below is observable.
      int acc = seed;
      for (int i = 0; i < 8; i++) acc = acc * 31 + i;
      b0 = acc;
      b1 = acc ^ seed;
    }
  }
  static class Derived extends Base {
    int d0, d1;
    Derived(int seed) {
      super(seed);
      // Reads superclass state written by the super constructor. If a compiled
      // <init> could observe the object before super ran, this would differ.
      int acc = b0;
      for (int i = 0; i < 8; i++) acc = acc * 17 + b1;
      d0 = acc;
      d1 = acc + b0;
    }
  }
  static class Thrower {
    int set;
    Thrower(int n) {
      int acc = n;
      for (int i = 0; i < 8; i++) acc = acc * 13 + i;
      set = acc;
      if (n < 0) throw new IllegalStateException("negative");
    }
  }

  public static void build(int[] out, int n) {
    int sum = 0;
    for (int i = 0; i < n; i++) {
      Derived d = new Derived(i);
      sum += d.d0 + d.d1 + d.b0 + d.b1;
    }
    out[0] = sum;
  }

  public static void throwing(int[] out, int n) {
    int caught = 0;
    int sum = 0;
    for (int i = 0; i < n; i++) {
      try {
        Thrower t = new Thrower(i % 7 == 3 ? -i : i);
        sum += t.set;
      } catch (IllegalStateException e) {
        caught++;
      }
    }
    out[0] = sum;
    out[1] = caught;
  }
}
`;

async function makeHarness(t, extraEnv) {
  withEnv(t, { JVM_WASM_JIT: '1', JVM_WASM_STRUCTURED: '1', ...extraEnv });
  const classpath = compileJavaFixture(t, 'CtorGate', SOURCE);
  const jvm = new JVM({ classpath, jit: { compileWorker: false, warmupThreshold: 100 } });
  await jvm.loadClassByName('CtorGate');
  jvm.classInitializationState.set('CtorGate', 'INITIALIZED');
  const thread = {
    id: 0, name: 'ctorgate-test', callStack: new Stack(),
    status: 'runnable', pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  return { jvm, thread };
}

function referenceBuild(n) {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    let acc = i;
    for (let k = 0; k < 8; k++) acc = (Math.imul(acc, 31) + k) | 0;
    const b0 = acc, b1 = (acc ^ i) | 0;
    let acc2 = b0;
    for (let k = 0; k < 8; k++) acc2 = (Math.imul(acc2, 17) + b1) | 0;
    const d0 = acc2, d1 = (acc2 + b0) | 0;
    sum = (sum + d0 + d1 + b0 + b1) | 0;
  }
  return sum | 0;
}

function referenceThrowing(n) {
  let caught = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    const seed = i % 7 === 3 ? -i : i;
    let acc = seed;
    for (let k = 0; k < 8; k++) acc = (Math.imul(acc, 13) + k) | 0;
    if (seed < 0) { caught++; continue; }
    sum = (sum + acc) | 0;
  }
  return [sum | 0, caught];
}

test('<clinit> is never a candidate, whatever the constructor flag says', async (t) => {
  const { jvm } = await makeHarness(t, { JVM_WASM_CTOR: '1' });
  t.ok(jvm.jit.wasmJit.ctorCompileEnabled, 'constructors are enabled for this run');

  const census = new Map();
  jvm.jit.wasmJit.census = census;
  const clinitFrame = {
    method: { name: '<clinit>', descriptor: '()V' },
    className: 'CtorGate',
    instructions: [],
  };
  t.equal(jvm.jit.wasmJit.prepare(clinitFrame), null,
    'a <clinit> frame is refused even with constructors enabled');
  const row = census.get('CtorGate.<clinit>()V');
  t.ok(row && row.reasons.has('clinit'),
    'and it is recorded as clinit, not fused with ctor');
  t.end();
});

test('constructors are excluded by default and recorded separately', async (t) => {
  const { jvm, thread } = await makeHarness(t, {});
  jvm.jit.wasmJit.census = new Map();
  t.notOk(jvm.jit.wasmJit.ctorCompileEnabled, 'the flag is off by default');

  const out = [0];
  out.type = '[I';
  await invoke(jvm, thread, 'CtorGate', 'build', '([II)V', [out, 400]);
  t.equal(out[0], referenceBuild(400), 'the guest result is correct');

  const reasons = [...(jvm.jit.wasmJit.census.get(
    'CtorGate$Derived.<init>(I)V') || { reasons: new Map() }).reasons.keys()];
  t.ok(reasons.includes('ctor'),
    `the constructor is refused as 'ctor' (${reasons.join(', ') || 'none'})`);
  t.notOk(reasons.includes('clinit'),
    'and never mislabelled as class initialization');
  t.end();
});

test('a compiled constructor preserves superclass ordering and field values', async (t) => {
  const { jvm, thread } = await makeHarness(t, { JVM_WASM_CTOR: '1' });
  const out = [0];
  out.type = '[I';
  await invoke(jvm, thread, 'CtorGate', 'build', '([II)V', [out, 400]);
  t.equal(out[0], referenceBuild(400),
    'every field the derived constructor read from its superclass was already written');

  const ctor = await jvm.findMethodInHierarchy('CtorGate$Derived', '<init>', '(I)V');
  const state = jvm.jit.wasmJit.state.get(ctor);
  t.ok(state, 'the constructor reached the wasm tier at all');
  t.end();
});

test('a constructor that throws part-way leaves the same observable state', async (t) => {
  const { jvm, thread } = await makeHarness(t, { JVM_WASM_CTOR: '1' });
  const out = [0, 0];
  out.type = '[I';
  await invoke(jvm, thread, 'CtorGate', 'throwing', '([II)V', [out, 400]);
  const [sum, caught] = referenceThrowing(400);
  t.equal(out[0], sum, 'the completed constructions contribute exactly their fields');
  t.equal(out[1], caught, 'and every throwing construction is caught, none lost or doubled');
  t.ok(caught > 0, 'the fixture really did throw');
  t.end();
});

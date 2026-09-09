'use strict';

// The direct wasm->wasm static link (JVM_WASM_DIRECT_STATIC_LINK, on by
// default): an `invokestatic` whose callee is ready, fully compiled and
// takes its arguments in the identity slot order calls that callee's `runv`
// export from inside wasm, with no JS bridge on the path.
//
// A static site has no per-call fallback arm. Unlike an instance site --
// which keeps the generic dispatch import for every receiver its guard
// refuses -- the choice here is made once, at codegen: the site is a
// `dcall_` import or it is the JS never-exits bridge, for the life of the
// module. So the emission record IS the crossing record, and the path
// evidence below is an emission count rather than a call counter:
//   * `meta.directStaticLinks` -- how many static sites this module lowered
//     to a direct link.
//   * the site's entry in `meta.linkBindings`, whose `direct` flag separates
//     a `dcall_` from a bridged never-exits call. Both record
//     classification 'compatible' and lateBound:false, so without that flag
//     a test cannot tell whether the link under test happened at all.
// (`JVM_WASM_IMPORT_STATS` is deliberately NOT used: it wraps every import
// in a counting JS closure, `dcall_` included, which turns the direct call
// back into the JS crossing whose absence is the property being tested.)

const test = require('tape');
const { makeJavaFixtureCompiler } = require('./javaFixture');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');

const compileJavaFixture = makeJavaFixtureCompiler('direct-static-link-');

async function invoke(jvm, thread, className, methodName, descriptor, locals) {
  const method = await jvm.findMethodInHierarchy(className, methodName, descriptor);
  const frame = new Frame(method);
  frame.className = className;
  locals.forEach((value, index) => { frame.locals[index] = value; });
  const before = thread.callStack.size();
  thread.callStack.push(frame);
  let ticks = 0;
  while (thread.callStack.size() > before) {
    const result = await jvm.executeTick();
    ticks += 1;
    if (result.completed) break;
    if (ticks > 50000000) throw new Error('tick limit');
  }
}

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

// The default configuration is the subject here, so the direct-link
// variables are UNSET rather than pinned to '1': a test that switches the
// feature on cannot say whether the shipped default reaches it.
async function makeHarness(t, className, source, extraEnv = {}) {
  withEnv(t, {
    JVM_WASM_JIT: '1',
    JVM_WASM_DIRECT_STATIC_LINK: undefined,
    JVM_WASM_DIRECT_INSTANCE_LINK: undefined,
    ...extraEnv,
  });
  const classpath = compileJavaFixture(t, className, source);
  const jvm = new JVM({ classpath, jit: { warmupThreshold: 100 } });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const thread = {
    id: 0,
    name: 'direct-static-link-test',
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

// The binding this caller recorded for one callee key, whatever backend
// lowered it.
function bindingFor(st, key) {
  const list = (st && st.meta && st.meta.linkBindings) || [];
  return list.find((b) => (b.key || `${b.className}.${b.name}${b.descriptor}`) === key) || null;
}

function staticFieldOf(jvm, className, key) {
  const cells = jvm.classes[className] && jvm.classes[className].staticFields;
  if (!cells) return undefined;
  return typeof cells.get === 'function' ? cells.get(key) : cells[key];
}

const SOURCE = `
public class DirectStaticLinkContract {
  // Eligible: its only local is its parameter, so runv's parameter list and
  // the descriptor's argument list are the same list.
  public static int mix(int v) {
    v = (v * 31 + 1) & 0xfffff;
    v = (v * 17 + 3) & 0xfffff;
    v = (v * 13 + 5) & 0xfffff;
    v = (v * 11 + 7) & 0xfffff;
    v = (v * 7 + 11) & 0xfffff;
    v = (v * 5 + 13) & 0xfffff;
    return v;
  }
  // Ineligible: the loop counter is a local past the parameters, and runv
  // has no argument for it.
  public static int mixLocals(int v) {
    int r = v;
    for (int k = 0; k < 6; k++) r = (r * 31 + k) & 0xfffff;
    return r;
  }
  public static int drive(int[] out, int n) {
    int s = 0;
    for (int i = 0; i < n; i++) s = (s + mix(s + i)) & 0xfffff;
    out[0] = s;
    return s;
  }
  public static int driveLocals(int[] out, int n) {
    int s = 0;
    for (int i = 0; i < n; i++) s = (s + mixLocals(s + i)) & 0xfffff;
    out[0] = s;
    return s;
  }
  public static int driveInit(int[] out, int n) {
    int s = 0;
    for (int i = 0; i < n; i++) s = (s + Initee.compute(s + i)) & 0xfffff;
    out[0] = s;
    return s;
  }
  public static int faulty(int[] c, int[] a, int v) {
    v = (v * 31 + 1) & 0xfffff;
    v = (v * 17 + 3) & 0xfffff;
    c[0] = c[0] + 1;
    return (v + a[0]) & 0xfffff;
  }
  public static int driveFaulty(int[] c, int[] a, int n) {
    int s = 0;
    for (int i = 0; i < n; i++) s = (s + faulty(c, a, s + i)) & 0xfffff;
    return s;
  }
  public static void faultOuter(int[] out, int[] c, int[] a, int n) {
    try {
      out[0] = driveFaulty(c, a, n);
      out[1] = 1;
    } catch (NullPointerException e) {
      out[1] = -1;
    }
  }
  public static int viaNode(Node node, int v) {
    v = (v * 31 + 1) & 0xfffff;
    v = (v * 17 + 3) & 0xfffff;
    v = (v * 13 + 5) & 0xfffff;
    return (v + node.step(v)) & 0xfffff;
  }
  public static int driveMixed(int[] out, Node node, int n) {
    int s = 0;
    for (int i = 0; i < n; i++) s = (s + viaNode(node, s + i)) & 0xfffff;
    out[0] = s;
    return s;
  }
}
class Sink { static int hits; }
class Initee {
  static int base;
  static { Sink.hits++; base = 5; }
  static int compute(int v) {
    v = (v + base) & 0xfffff;
    v = (v * 31 + 1) & 0xfffff;
    v = (v * 17 + 3) & 0xfffff;
    v = (v * 13 + 5) & 0xfffff;
    v = (v * 11 + 7) & 0xfffff;
    return v;
  }
}
class Node {
  int step(int v) { return (v * 5 + 1) & 0xfffff; }
}
`;

const mask = 0xfffff;
const mix = (v) => {
  let x = v | 0;
  x = (Math.imul(x, 31) + 1) & mask;
  x = (Math.imul(x, 17) + 3) & mask;
  x = (Math.imul(x, 13) + 5) & mask;
  x = (Math.imul(x, 11) + 7) & mask;
  x = (Math.imul(x, 7) + 11) & mask;
  x = (Math.imul(x, 5) + 13) & mask;
  return x;
};
const mixLocals = (v) => {
  let r = v | 0;
  for (let k = 0; k < 6; k += 1) r = (Math.imul(r, 31) + k) & mask;
  return r;
};
const compute = (v) => {
  let x = ((v | 0) + 5) & mask;
  x = (Math.imul(x, 31) + 1) & mask;
  x = (Math.imul(x, 17) + 3) & mask;
  x = (Math.imul(x, 13) + 5) & mask;
  x = (Math.imul(x, 11) + 7) & mask;
  return x;
};
const viaNode = (v) => {
  let x = v | 0;
  x = (Math.imul(x, 31) + 1) & mask;
  x = (Math.imul(x, 17) + 3) & mask;
  x = (Math.imul(x, 13) + 5) & mask;
  return (x + ((Math.imul(x, 5) + 1) & mask)) & mask;
};

function reference(n, f) {
  let s = 0;
  for (let i = 0; i < n; i += 1) s = ((s + f((s + i) | 0)) | 0) & 0xfffff;
  return s;
}

const N = 6000;
const MIX = 'DirectStaticLinkContract.mix(I)I';
const DRIVE = 'DirectStaticLinkContract.drive([II)I';

async function loaded(jvm, ...names) {
  for (const name of names) {
    await jvm.loadClassByName(name);
    jvm.classInitializationState.set(name, 'INITIALIZED');
  }
}

function ints(...values) {
  const a = values.slice();
  a.type = '[I';
  return a;
}

test('an eligible static call links directly under the shipped default', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'DirectStaticLinkContract', SOURCE);
  t.equal(jvm.jit.wasmJit.directStaticLinkEnabled, true,
    'direct static links are on with the variable unset');
  const out = ints(0, 0);
  for (let round = 0; round < 3; round += 1) {
    await invoke(jvm, thread, 'DirectStaticLinkContract', 'drive', '([II)I', [out, N]);
    t.equal(out[0], reference(N, mix), `round ${round} matches the Java reference`);
  }
  const st = stateOf(jvm, DRIVE);
  t.ok(st && st.meta, 'drive compiled to wasm');
  t.ok(st.meta.directStaticLinks >= 1,
    `the invokestatic site lowered to a dcall_ (${st.meta.directStaticLinks})`);
  const binding = bindingFor(st, MIX);
  t.ok(binding && binding.direct === true, 'and its binding records the direct shape');
  t.equal(st.meta.deoptableCalls, 0, 'a non-partial direct link leaves the caller never-exits');
  t.equal(st.exits, 0, 'the caller never left wasm');
  t.end();
});

test('the explicit opt-out keeps the same call on the JS bridge', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'DirectStaticLinkContract', SOURCE,
    { JVM_WASM_DIRECT_STATIC_LINK: '0' });
  t.equal(jvm.jit.wasmJit.directStaticLinkEnabled, false, 'the opt-out is honoured');
  const out = ints(0, 0);
  for (let round = 0; round < 3; round += 1) {
    await invoke(jvm, thread, 'DirectStaticLinkContract', 'drive', '([II)I', [out, N]);
    t.equal(out[0], reference(N, mix), `round ${round} still matches`);
  }
  const st = stateOf(jvm, DRIVE);
  t.ok(st && st.meta, 'drive still compiled to wasm');
  t.equal(st.meta.directStaticLinks || 0, 0, 'no site lowered to a dcall_');
  const binding = bindingFor(st, MIX);
  t.ok(binding && !binding.direct, 'the binding records the bridged shape');
  t.equal(st.exits, 0, 'and the bridged caller still never left wasm');
  t.end();
});

// The runv export takes one wasm parameter per java LOCAL slot, not per
// descriptor argument, and a caller has values only for the arguments. So
// the direct link is admitted exactly when the callee's locals are its
// parameters -- `identityParams`. This is the contract's real edge, and a
// callee one local past it has to keep working, on the bridge.
test('a callee with locals past its parameters keeps the bridge and stays correct',
  async (t) => {
    const { jvm, thread } = await makeHarness(t, 'DirectStaticLinkContract', SOURCE);
    const out = ints(0, 0);
    for (let round = 0; round < 3; round += 1) {
      await invoke(jvm, thread, 'DirectStaticLinkContract', 'driveLocals', '([II)I', [out, N]);
      t.equal(out[0], reference(N, mixLocals), `round ${round} matches the Java reference`);
    }
    const callee = stateOf(jvm, 'DirectStaticLinkContract.mixLocals(I)I');
    t.ok(callee && callee.meta, 'the callee compiled to wasm');
    t.ok(callee.meta.paramSlots.length > 1,
      `and takes more runv parameters than the descriptor has arguments (${callee.meta.paramSlots.length} vs 1)`);
    const st = stateOf(jvm, 'DirectStaticLinkContract.driveLocals([II)I');
    t.ok(st && st.meta, 'the caller compiled to wasm');
    t.equal(st.meta.directStaticLinks || 0, 0,
      'so the site did not link directly, even with the feature on');
    const binding = bindingFor(st, 'DirectStaticLinkContract.mixLocals(I)I');
    t.ok(binding && !binding.direct, 'it kept the bridged shape');
    t.equal(st.exits, 0, 'and the bridged caller still never left wasm');
    t.end();
  });

test('a callee whose class is not initialized yet is not linked, and its <clinit> still runs',
  async (t) => {
    const { jvm, thread } = await makeHarness(t, 'DirectStaticLinkContract', SOURCE);
    // Neither class is forced INITIALIZED: marking a class initialized
    // without running its <clinit> would skip the very side effect under
    // test (and leave its static field cells uncreated).
    await jvm.loadClassByName('Sink');
    await jvm.loadClassByName('Initee');
    // Deliberately NOT marked INITIALIZED: this is the state in which a link
    // would skip an observable class initializer.
    t.notEqual(jvm.classInitializationState.get('Initee'), 'INITIALIZED',
      'Initee starts uninitialized');
    const out = ints(0, 0);
    for (let round = 0; round < 3; round += 1) {
      await invoke(jvm, thread, 'DirectStaticLinkContract', 'driveInit', '([II)I', [out, N]);
      t.equal(out[0], reference(N, compute), `round ${round} matches the Java reference`);
    }
    t.equal(staticFieldOf(jvm, 'Sink', 'hits:I'), 1,
      'the class initializer ran exactly once, however the site was lowered');
    t.equal(staticFieldOf(jvm, 'Initee', 'base:I'), 5,
      'and it published its field before any call read it');
    t.end();
  });

test('an exception raised inside a directly linked callee reaches the Java handler',
  async (t) => {
    const { jvm, thread } = await makeHarness(t, 'DirectStaticLinkContract', SOURCE);
    const out = ints(0, 0);
    const counter = ints(0);
    const a = ints(11);
    // Warm the pair on a healthy array first, so the fault arrives at an
    // already-linked site rather than one that never compiled.
    for (let round = 0; round < 3; round += 1) {
      counter[0] = 0;
      await invoke(jvm, thread, 'DirectStaticLinkContract', 'faultOuter',
        '([I[I[II)V', [out, counter, a, N]);
      t.equal(out[1], 1, `round ${round} completed normally`);
      t.equal(counter[0], N, `round ${round} ran the side effect once per call`);
    }
    const st = stateOf(jvm, 'DirectStaticLinkContract.driveFaulty([I[II)I');
    t.ok(st && st.meta, 'driveFaulty compiled to wasm');
    t.ok(st.meta.directStaticLinks >= 1,
      `its call into faulty is a direct link (${st.meta.directStaticLinks})`);

    // The fault: a null array inside the linked callee. Whether that surfaces
    // by trapping out of wasm or by deopting back to the interpreter, the
    // store that precedes it must not be replayed -- a resumption that
    // re-enters the callee from its first instruction would count twice.
    counter[0] = 0;
    out[1] = 0;
    await invoke(jvm, thread, 'DirectStaticLinkContract', 'faultOuter',
      '([I[I[II)V', [out, counter, null, 4]);
    t.equal(out[1], -1, 'the NullPointerException reached the catch clause');
    t.equal(counter[0], 1,
      `the side effect before the throwing op ran exactly once (${counter[0]})`);
    t.end();
  });

test('withdrawing the callee leaves the pinned direct link correct', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'DirectStaticLinkContract', SOURCE);
  const out = ints(0, 0);
  for (let round = 0; round < 3; round += 1) {
    await invoke(jvm, thread, 'DirectStaticLinkContract', 'drive', '([II)I', [out, N]);
  }
  const st = stateOf(jvm, DRIVE);
  t.ok(st.meta.directStaticLinks >= 1, 'the site is linked before the withdrawal');
  const callee = stateOf(jvm, MIX);
  t.ok(callee && callee.status === 'ready', 'the callee owns a ready module');

  // A withdrawal is not a redefinition: the module the caller pinned is
  // still a correct compilation of the same bytecode, and the contract is
  // that the caller keeps entering it until the caller itself recompiles.
  // What must not happen is a wrong answer or a lost call.
  jvm.jit.wasmJit.withdrawModule(callee);
  t.equal(callee.status, 'cold', 'the callee module is withdrawn');
  await invoke(jvm, thread, 'DirectStaticLinkContract', 'drive', '([II)I', [out, N]);
  t.equal(out[0], reference(N, mix), 'the caller still agrees with the reference');
  t.equal(st.exits, 0, 'and did not exit wasm to discover the withdrawal');
  t.end();
});

// The interaction with instance linking, in the direction that matters: an
// instance site keeps the generic dispatch import as its slow path, so it is
// a deoptable site, so meta.deoptableCalls is non-zero -- and a static direct
// link requires a callee that can never exit. The two therefore do not nest:
// a method containing an instance call is not itself statically linkable,
// however well its own instance site links.
test('a callee containing an instance call is deoptable, so it keeps the static bridge',
  async (t) => {
    const { jvm, thread } = await makeHarness(t, 'DirectStaticLinkContract', SOURCE);
    await loaded(jvm, 'Node');
    const node = { type: 'Node', fields: {} };
    const out = ints(0, 0);
    for (let round = 0; round < 3; round += 1) {
      await invoke(jvm, thread, 'DirectStaticLinkContract', 'driveMixed',
        '([ILNode;I)I', [out, node, N]);
      t.equal(out[0], reference(N, viaNode), `round ${round} matches the Java reference`);
    }
    const inner = stateOf(jvm, 'DirectStaticLinkContract.viaNode(LNode;I)I');
    t.ok(inner && inner.meta, 'the middle method compiled to wasm');
    t.ok(inner.meta.deoptableCalls >= 1,
      `its instance site makes it deoptable (${inner.meta.deoptableCalls})`);
    t.ok(inner.meta.directLinks >= 1,
      `and that instance site is itself directly linked (${inner.meta.directLinks})`);

    const outer = stateOf(jvm, 'DirectStaticLinkContract.driveMixed([ILNode;I)I');
    t.ok(outer && outer.meta, 'the driver compiled to wasm');
    t.equal(outer.meta.directStaticLinks || 0, 0,
      'so the static call into it stays on the bridge');

    // Growing the class world disarms the callee's specok flag. The static
    // call reaches it through the bridge, which re-reads the state per call,
    // so this is the interaction actually exercised: a disarmed speculative
    // callee entered from another wasm module.
    await jvm.loadClassByName('Sink');
    t.equal(inner.meta.specok.value, 0, 'registering a class zeroes specok');
    await invoke(jvm, thread, 'DirectStaticLinkContract', 'driveMixed',
      '([ILNode;I)I', [out, node, N]);
    t.equal(out[0], reference(N, viaNode),
      'and the disarmed callee is still correct');
    t.end();
  });

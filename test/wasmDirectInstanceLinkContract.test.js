'use strict';

// The direct wasm->wasm instance link (JVM_WASM_DIRECT_INSTANCE_LINK): a
// site whose whole dispatch is one ready, fully compiled target calls that
// target's `runv` export from inside wasm, with no JS bridge on the path.
// The generic dispatch import stays in the module as the complete slow path,
// so everything the fast path refuses -- a null receiver, a receiver the
// guard does not admit, a late target, a deopt -- still runs exactly as it
// does with the link disabled.
//
// A test that only checks results proves nothing here: the same results come
// out when the link was never emitted. Every case below therefore also
// records WHICH path ran. Two signals do that without changing the code
// under test:
//   * `meta.directLinks` -- how many sites the module emitted a direct link
//     for. Zero means the fast path does not exist in this module at all.
//   * `wasmJit.siteStats` -- the generic dispatch import's own per-site call
//     counter. It is normally allocated only under JVM_DEBUG_WASMJIT; the
//     tests install the map themselves so they can count bridge entries
//     without the debug logging. A loop of N calls that leaves the site's
//     `calls` at zero ran entirely on the direct path.
// (`JVM_WASM_IMPORT_STATS` is deliberately NOT used: it wraps every import
// in a counting JS closure, including `dcall_`, which turns the direct call
// back into a JS crossing. It can say a link exists; it cannot be on while
// the property being measured is that no JS runs.)

const test = require('tape');
const { makeJavaFixtureCompiler } = require('./javaFixture');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');
const { hasUncheckedSpeculation } = require('../src/jit/wasmShared');

const compileJavaFixture = makeJavaFixtureCompiler('direct-instance-link-');

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

async function makeHarness(t, className, source, extraEnv = {}) {
  withEnv(t, {
    JVM_WASM_JIT: '1',
    JVM_WASM_CHECKCAST: '1',
    JVM_DISABLE_WASM_LATE_INSTANCE_TARGETS: '0',
    JVM_WASM_DIRECT_INSTANCE_LINK: '1',
    ...extraEnv,
  });
  const classpath = compileJavaFixture(t, className, source);
  const jvm = new JVM({ classpath, jit: { warmupThreshold: 100 } });
  // Before anything compiles: the generic bridge reads this map at emit time.
  jvm.jit.wasmJit.siteStats = new Map();
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const thread = {
    id: 0,
    name: 'direct-link-test',
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

// Generic-dispatch-import entries for every instance site of one method.
function bridgeCalls(jvm, callerClass, callerName) {
  let total = 0;
  for (const [key, stats] of jvm.jit.wasmJit.siteStats) {
    if (key.startsWith('vcall_') && key.includes(`@${callerClass}.${callerName}:`)) {
      total += stats.calls;
    }
  }
  return total;
}

const SOURCE = `
public class DirectLinkContract {
  public static int spin(int[] out, Node node, int n) {
    int s = 0;
    for (int i = 0; i < n; i++) s = (s + node.step(s + i)) & 0xfffff;
    out[0] = s;
    return s;
  }
  public static int tick(int[] out, Ticker t, int n) {
    int s = 0;
    for (int i = 0; i < n; i++) s = (s + t.tick(s + i)) & 0xfffff;
    out[0] = s;
    return s;
  }
  public static void nullPath(int[] out, Node node, int n) {
    try {
      out[0] = spin(out, node, n);
      out[1] = 1;
    } catch (NullPointerException e) {
      out[1] = -1;
    }
  }
  public static int bumpLoop(int[] out, Node node, int n) {
    int s = 0;
    for (int i = 0; i < n; i++) s = (s + node.bump(s + i)) & 0xfffff;
    out[0] = s;
    return s;
  }
  public static int mixed(int[] out, Ticker t, int n) {
    int s = 0;
    for (int i = 0; i < n; i++) s = (s + t.tick(s + i)) & 0xfffff;
    out[0] = s;
    return s;
  }
  public static int guarded(int[] out, Guard g, int n) {
    int s = 0;
    for (int i = 0; i < n; i++) s = (s + g.take(s + i)) & 0xfffff;
    out[0] = s;
    return s;
  }
  public static int overSuper(int[] out, int n) {
    Lower low = new Lower();
    int s = 0;
    for (int i = 0; i < n; i++) s = (s + low.viaSuper(s + i)) & 0xfffff;
    out[0] = s;
    return s;
  }
}
class Node {
  int step(int v) { return (v * 3) ^ 1; }
  int bump(int v) { Sink.hits++; return v + 2; }
}
class Node2 extends Node {
  int step(int v) { return v + 1000; }
  int bump(int v) { Sink.hits++; return v + 5; }
}
interface Ticker { int tick(int v); }
class TickerA implements Ticker { public int tick(int v) { return (v * 7) ^ 3; } }
class TickerB implements Ticker { public int tick(int v) { return v - 9; } }
class TickerC implements Ticker { public synchronized int tick(int v) { return v * 11; } }
class Guard { int take(int v) { try { return v / (v & 1); } catch (ArithmeticException e) { return v + 4; } } }
class Upper { int viaSuper(int v) { return (v & 0xffff) * 5 + 2; } }
class Lower extends Upper { int viaSuper(int v) { return super.viaSuper(v) ^ 9; } }
class Sink { static int hits; }
`;

const step1 = (v) => (Math.imul(v, 3) ^ 1) | 0;
const step2 = (v) => (v + 1000) | 0;
const tickA = (v) => (Math.imul(v, 7) ^ 3) | 0;
const tickB = (v) => (v - 9) | 0;
const tickC = (v) => Math.imul(v, 11) | 0;

function reference(n, f) {
  let s = 0;
  for (let i = 0; i < n; i += 1) s = ((s + f((s + i) | 0)) | 0) & 0xfffff;
  return s;
}

const N = 6000;

async function loaded(jvm, ...names) {
  for (const name of names) {
    await jvm.loadClassByName(name);
    jvm.classInitializationState.set(name, 'INITIALIZED');
  }
}

test('a stable receiver type runs every call on the direct path', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'DirectLinkContract', SOURCE);
  await loaded(jvm, 'Node');
  const node = { type: 'Node', fields: {} };
  const out = [0, 0];
  out.type = '[I';
  for (let round = 0; round < 3; round += 1) {
    await invoke(jvm, thread, 'DirectLinkContract', 'spin', '([ILNode;I)I', [out, node, N]);
    t.equal(out[0], reference(N, step1), `round ${round} matches the Java reference`);
  }
  const st = stateOf(jvm, 'DirectLinkContract.spin([ILNode;I)I');
  t.ok(st && st.meta, 'spin compiled to wasm');
  t.ok(st.meta.directLinks >= 1, 'the invokevirtual site emitted a direct link');
  t.ok(st.meta.specok, 'the monomorphic cone links behind the specok flag');
  t.equal(st.meta.specok.value, 1, 'specok is armed while the world matches');
  t.equal(bridgeCalls(jvm, 'DirectLinkContract', 'spin'), 0,
    'no call reached the generic dispatch import');
  t.equal(st.exits, 0, 'the caller never left wasm');
  t.end();
});

test('an interface site with one implementation links and keeps dispatching after a second appears',
  async (t) => {
    const { jvm, thread } = await makeHarness(t, 'DirectLinkContract', SOURCE);
    await loaded(jvm, 'Ticker', 'TickerA');
    const a = { type: 'TickerA', fields: {} };
    const out = [0, 0];
    out.type = '[I';
    for (let round = 0; round < 3; round += 1) {
      await invoke(jvm, thread, 'DirectLinkContract', 'tick', '([ILTicker;I)I', [out, a, N]);
      t.equal(out[0], reference(N, tickA), `round ${round} matches`);
    }
    const st = stateOf(jvm, 'DirectLinkContract.tick([ILTicker;I)I');
    t.ok(st && st.meta.directLinks >= 1, 'invokeinterface emitted a direct link');
    t.equal(bridgeCalls(jvm, 'DirectLinkContract', 'tick'), 0,
      'the interface calls ran on the direct path');
    const armed = st.meta.specok;
    t.equal(armed.value, 1, 'specok armed');

    // A second implementation makes the baked cone wrong. Registering it
    // must drop the flag synchronously -- a receiver arriving in the same
    // tick as the class load must not find a stale fast path armed.
    await loaded(jvm, 'TickerB');
    t.equal(armed.value, 0, 'registering a second implementation zeroes specok');
    const b = { type: 'TickerB', fields: {} };
    await invoke(jvm, thread, 'DirectLinkContract', 'tick', '([ILTicker;I)I', [out, b, N]);
    t.equal(out[0], reference(N, tickB), 'the new implementation dispatches correctly');
    await invoke(jvm, thread, 'DirectLinkContract', 'tick', '([ILTicker;I)I', [out, a, N]);
    t.equal(out[0], reference(N, tickA), 'the original implementation is still correct');
    t.end();
  });

test('an overriding subclass loaded later dispatches to the override', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'DirectLinkContract', SOURCE);
  await loaded(jvm, 'Node');
  const node = { type: 'Node', fields: {} };
  const out = [0, 0];
  out.type = '[I';
  for (let round = 0; round < 3; round += 1) {
    await invoke(jvm, thread, 'DirectLinkContract', 'spin', '([ILNode;I)I', [out, node, N]);
  }
  const st = stateOf(jvm, 'DirectLinkContract.spin([ILNode;I)I');
  t.ok(st.meta.directLinks >= 1, 'the site linked directly against the one-impl cone');
  await loaded(jvm, 'Node2');
  const sub = { type: 'Node2', fields: {} };
  await invoke(jvm, thread, 'DirectLinkContract', 'spin', '([ILNode;I)I', [out, sub, N]);
  t.equal(out[0], reference(N, step2), 'the subclass receiver runs the override');
  await invoke(jvm, thread, 'DirectLinkContract', 'spin', '([ILNode;I)I', [out, node, N]);
  t.equal(out[0], reference(N, step1), 'the base receiver still runs the base method');
  const after = stateOf(jvm, 'DirectLinkContract.spin([ILNode;I)I');
  t.equal(after.meta.directLinks, 0,
    'the rebuilt module drops the link its speculation no longer supports');
  t.end();
});

test('a receiver the guard does not admit falls back to the generic bridge', async (t) => {
  // Both implementations are loaded, so the cone is not monomorphic and the
  // link cannot use the flag-only form: it must emit a receiver-class guard.
  // Only TickerA is linkable -- a synchronized method owns a monitor and a
  // linked call has no frame to hold one -- so the site has exactly one
  // ready target and a guard that admits only its classes.
  const { jvm, thread } = await makeHarness(t, 'DirectLinkContract', SOURCE);
  await loaded(jvm, 'Ticker', 'TickerA', 'TickerC');
  const a = { type: 'TickerA', fields: {} };
  const c = { type: 'TickerC', fields: {} };
  const out = [0, 0];
  out.type = '[I';
  for (let round = 0; round < 3; round += 1) {
    await invoke(jvm, thread, 'DirectLinkContract', 'mixed', '([ILTicker;I)I', [out, a, N]);
    t.equal(out[0], reference(N, tickA), `round ${round}: the admitted receiver matches`);
  }
  const st = stateOf(jvm, 'DirectLinkContract.mixed([ILTicker;I)I');
  t.ok(st && st.meta.directLinks >= 1, 'the site emitted a guarded direct link');
  t.notOk(st.meta.specok, 'a two-implementation cone uses the class guard, not the flag');
  t.equal(bridgeCalls(jvm, 'DirectLinkContract', 'mixed'), 0,
    'admitted receivers never entered the generic bridge');

  await invoke(jvm, thread, 'DirectLinkContract', 'mixed', '([ILTicker;I)I', [out, c, N]);
  t.equal(out[0], reference(N, tickC), 'the unadmitted receiver still computes correctly');
  t.ok(bridgeCalls(jvm, 'DirectLinkContract', 'mixed') > 0,
    'the unadmitted receiver took the generic bridge');

  const bridged = bridgeCalls(jvm, 'DirectLinkContract', 'mixed');
  await invoke(jvm, thread, 'DirectLinkContract', 'mixed', '([ILTicker;I)I', [out, a, N]);
  t.equal(out[0], reference(N, tickA), 'the admitted receiver is unaffected by the miss');
  t.equal(bridgeCalls(jvm, 'DirectLinkContract', 'mixed'), bridged,
    'and goes back to the direct path without re-entering the bridge');
  t.end();
});

test('a null receiver throws the guest NPE from the direct site', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'DirectLinkContract', SOURCE);
  await loaded(jvm, 'Node');
  const node = { type: 'Node', fields: {} };
  const out = [0, 0];
  out.type = '[I';
  for (let round = 0; round < 3; round += 1) {
    await invoke(jvm, thread, 'DirectLinkContract', 'nullPath', '([ILNode;I)V', [out, node, N]);
  }
  t.equal(out[0], reference(N, step1), 'the non-null case computes normally');
  t.equal(out[1], 1, 'the non-null case does not enter the handler');
  const st = stateOf(jvm, 'DirectLinkContract.spin([ILNode;I)I');
  t.ok(st && st.meta.directLinks >= 1, 'the linked site is the one under test');
  await invoke(jvm, thread, 'DirectLinkContract', 'nullPath', '([ILNode;I)V', [out, null, N]);
  t.equal(out[1], -1, 'a null receiver surfaces as a catchable Java NPE');
  t.end();
});

test('a callee that cannot satisfy the calling convention keeps the generic bridge',
  async (t) => {
    const { jvm, thread } = await makeHarness(t, 'DirectLinkContract', SOURCE);
    await loaded(jvm, 'Guard');
    const g = { type: 'Guard', fields: {} };
    const out = [0, 0];
    out.type = '[I';
    const take = (v) => ((v & 1) ? (v / 1) | 0 : (v + 4) | 0);
    for (let round = 0; round < 3; round += 1) {
      await invoke(jvm, thread, 'DirectLinkContract', 'guarded', '([ILGuard;I)I', [out, g, N]);
      t.equal(out[0], reference(N, take), `round ${round}: the unlinkable callee stays correct`);
    }
    const callee = stateOf(jvm, 'Guard.take(I)I');
    const st = stateOf(jvm, 'DirectLinkContract.guarded([ILGuard;I)I');
    if (callee && callee.meta) {
      t.ok(callee.meta.usedEh || !callee.meta.fullyCompiled || callee.meta.deoptableCalls,
        'the callee fails the direct-link contract');
    } else {
      t.pass('the callee has no linkable module at all');
    }
    if (st && st.meta) {
      t.equal(st.meta.directLinks || 0, 0, 'the caller emitted no direct link for it');
    } else {
      t.pass('the caller did not reach the wasm tier');
    }
    t.end();
  });

test('side effects happen exactly once across withdrawal and recompilation', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'DirectLinkContract', SOURCE);
  await loaded(jvm, 'Node', 'Sink');
  const node = { type: 'Node', fields: {} };
  const out = [0, 0];
  out.type = '[I';
  const bump = (v) => (v + 2) | 0;
  const rounds = 3;
  for (let round = 0; round < rounds; round += 1) {
    await invoke(jvm, thread, 'DirectLinkContract', 'bumpLoop', '([ILNode;I)I', [out, node, N]);
    t.equal(out[0], reference(N, bump), `round ${round} matches`);
  }
  const st = stateOf(jvm, 'DirectLinkContract.bumpLoop([ILNode;I)I');
  t.ok(st && st.meta.directLinks >= 1, 'the counting callee linked directly');
  // Static storage is a Map on some class shapes and a plain object on
  // others; read it either way rather than pinning one of them here.
  const readHits = () => {
    const store = jvm.classes.Sink.staticFields;
    return typeof store.get === 'function' ? store.get('hits:I') : store['hits:I'];
  };
  t.equal(readHits(), rounds * N, 'every linked call ran the side effect exactly once');

  // Withdraw the callee's module outright: a link captured the link-time
  // module, so the caller must keep producing correct results and must not
  // re-run or skip a single side effect.
  const calleeSt = stateOf(jvm, 'Node.bump(I)I');
  t.ok(calleeSt, 'the callee has its own state');
  jvm.jit.wasmJit.withdrawModule(calleeSt);
  await invoke(jvm, thread, 'DirectLinkContract', 'bumpLoop', '([ILNode;I)I', [out, node, N]);
  t.equal(out[0], reference(N, bump), 'the caller is correct after the callee is withdrawn');
  t.equal(readHits(), (rounds + 1) * N,
    'withdrawal neither repeats nor loses a side effect');
  t.end();
});

test('a withdrawn or recompiled module leaves the class-load walk', async (t) => {
  // Every class registration zeroes every registered specok flag. The set is
  // therefore walked once per class load for the life of the process, so a
  // module that is gone has to leave it -- otherwise enabling direct links
  // makes class loading cost grow with the number of modules ever built, a
  // cost no fixed-shape benchmark would show.
  const { jvm, thread } = await makeHarness(t, 'DirectLinkContract', SOURCE);
  await loaded(jvm, 'Node');
  const node = { type: 'Node', fields: {} };
  const out = [0, 0];
  out.type = '[I';
  for (let round = 0; round < 3; round += 1) {
    await invoke(jvm, thread, 'DirectLinkContract', 'spin', '([ILNode;I)I', [out, node, N]);
  }
  const wasmJit = jvm.jit.wasmJit;
  const registered = wasmJit.specokGlobals.size;
  t.ok(registered >= 1, 'the linked module registered its specok flag');
  const st = stateOf(jvm, 'DirectLinkContract.spin([ILNode;I)I');
  const flag = st.meta.specok;
  wasmJit.withdrawModule(st);
  t.notOk(wasmJit.specokGlobals.has(flag), 'withdrawal unregisters the flag');
  t.ok(wasmJit.specokGlobals.size < registered, 'the walk got shorter, not longer');

  // Recompiling must replace the registration, not add a second one.
  for (let round = 0; round < 3; round += 1) {
    await invoke(jvm, thread, 'DirectLinkContract', 'spin', '([ILNode;I)I', [out, node, N]);
    t.equal(out[0], reference(N, step1), `round ${round} after withdrawal matches`);
  }
  t.ok(wasmJit.specokGlobals.size <= registered,
    'a rebuilt module does not add a second registration');
  t.end();
});

test('an invokespecial super call links behind a bare null check', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'DirectLinkContract', SOURCE);
  await loaded(jvm, 'Upper', 'Lower');
  const out = [0, 0];
  out.type = '[I';
  const viaSuper = (v) => ((((v & 0xffff) * 5 + 2) | 0) ^ 9) | 0;
  for (let round = 0; round < 3; round += 1) {
    await invoke(jvm, thread, 'DirectLinkContract', 'overSuper', '([II)I', [out, N]);
    t.equal(out[0], reference(N, viaSuper), `round ${round} matches`);
  }
  const st = stateOf(jvm, 'Lower.viaSuper(I)I');
  t.ok(st && st.meta, 'the overriding method compiled');
  t.ok(st.meta.directLinks >= 1, 'the super call linked directly');
  t.equal(bridgeCalls(jvm, 'Lower', 'viaSuper'), 0,
    'the super call never entered the generic bridge');
  t.end();
});

test('a direct link does not make its module unlinkable as a callee', (t) => {
  // The regression this file was written for. `specSites` records two
  // different things: an inline-elided CHA site, which nothing inside the
  // module re-checks, and a speculative monomorphic direct link, which the
  // module's own specok flag gates. Treating both as "unchecked" refused
  // every module that merely contained a direct link from static linking,
  // and callers of such a method then lost every block
  // ("no supported blocks") the moment the flag was enabled.
  const site = { owner: 'Node', name: 'step', descriptor: '(I)I', guards: ['Node'] };
  const flag = { value: 1 };
  t.notOk(hasUncheckedSpeculation({ specSites: [], inlineSpecSites: [] }),
    'a module with no speculation is linkable');
  t.notOk(hasUncheckedSpeculation(
    { specSites: [site], inlineSpecSites: [], specok: flag }),
  'a direct-link speculation with its flag is linkable');
  t.ok(hasUncheckedSpeculation({ specSites: [site], inlineSpecSites: [site] }),
    'an inline-elided speculation is not linkable');
  t.ok(hasUncheckedSpeculation(
    { specSites: [site], inlineSpecSites: [], specok: null }),
  'a link speculation without its flag is not linkable');
  t.ok(hasUncheckedSpeculation({ specSites: [site] }),
    'a meta from before the split is treated as unchecked');
  t.ok(hasUncheckedSpeculation({ speculations: 1, specSites: [site], inlineSpecSites: [] }),
    'an emitted instanceof guard is still counted as speculation');
  t.end();
});

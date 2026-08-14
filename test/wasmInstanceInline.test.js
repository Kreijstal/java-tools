'use strict';

// Instance-call inlining in the structured backend: CHA-guarded splices of
// mono/bimorphic callees, interior chains with checkcast, guard-miss deopt
// to the interpreter (null receivers, classes loaded after compile), and
// classEpoch invalidation of speculative modules.

const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');

function compileJavaFixture(t, className, source) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instance-inline-fixture-'));
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

async function makeHarness(t, className, source, preload, env = {}) {
  withEnv(t, { JVM_WASM_JIT: '1', JVM_WASM_STRUCTURED: '1', ...env });
  const classpath = compileJavaFixture(t, className, source);
  const jvm = new JVM({ classpath, jit: { warmupThreshold: 100 } });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  for (const extra of preload || []) {
    await jvm.loadClassByName(extra);
    jvm.classInitializationState.set(extra, 'INITIALIZED');
  }
  const thread = {
    id: 0,
    name: 'instance-inline-test',
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

const BIMORPHIC_SOURCE = `
public class InstInline {
  public static int drive(int[] out, Base b, int n) {
    int sum = 0;
    for (int i = 0; i < n; i++) sum += b.val() + i;
    out[0] = sum;
    return sum;
  }
  public static void driveNull(int[] out, Base b, int n) {
    int r;
    try { r = drive(out, b, n); } catch (NullPointerException e) { r = -42; }
    out[0] = r;
  }
  public static int drain(int[] out, Base b, int n) {
    int s = 0;
    for (int i = 0; i < n; i++) { s += b.f; b.f = b.f - 1; }
    out[0] = s;
    return s;
  }
}
class Base { int f; int val() { return f; } }
class Sub extends Base { int val() { return f * 2; } }
class Third extends Base { int val() { return f + 100; } }
class Unrelated { int x; }
`;

function expectedSum(per, n) {
  let sum = 0;
  for (let i = 0; i < n; i++) sum = (sum + per + i) | 0;
  return sum;
}

test('bimorphic instance call inlines with CHA guards and matches semantics', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'InstInline', BIMORPHIC_SOURCE, ['Base', 'Sub']);
  const n = 5000;
  const out = [0];
  out.type = '[I';
  const base = { type: 'Base', fields: { 'Base.f': 7 } };
  const sub = { type: 'Sub', fields: { 'Base.f': 7 } };

  await invoke(jvm, thread, 'InstInline', 'drive', '([ILBase;I)I', [out, base, n]);
  t.equal(out[0], expectedSum(7, n), 'Base receiver result matches');
  await invoke(jvm, thread, 'InstInline', 'drive', '([ILBase;I)I', [out, sub, n]);
  t.equal(out[0], expectedSum(14, n), 'Sub receiver result matches');

  const meta = metaOf(jvm, 'InstInline.drive([ILBase;I)I');
  t.ok(meta && meta.structured, 'drive compiled by the structured backend');
  t.ok(meta.inlinedCalls >= 1, 'call site was inlined');
  t.equal(meta.speculations, 2, 'two instanceof guards recorded');
  t.ok(meta.deoptStubCount >= 1, 'guard-miss deopt stub present');
  t.notOk(meta.fullyCompiled, 'speculative module is never fully compiled');
  t.end();
});

test('null receiver takes the deopt stub and throws the interpreter NPE', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'InstInline', BIMORPHIC_SOURCE, ['Base', 'Sub']);
  const n = 5000;
  const out = [0];
  out.type = '[I';
  const base = { type: 'Base', fields: { 'Base.f': 3 } };
  await invoke(jvm, thread, 'InstInline', 'drive', '([ILBase;I)I', [out, base, n]);
  t.ok(metaOf(jvm, 'InstInline.drive([ILBase;I)I'), 'drive is compiled before the null call');

  await invoke(jvm, thread, 'InstInline', 'driveNull', '([ILBase;I)V', [out, null, n]);
  t.equal(out[0], -42, 'NPE surfaced through the guard-miss deopt');
  t.end();
});

test('class loaded after compile misses the guards and invalidates the module', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'InstInline', BIMORPHIC_SOURCE, ['Base', 'Sub']);
  const n = 5000;
  const out = [0];
  out.type = '[I';
  const base = { type: 'Base', fields: { 'Base.f': 2 } };
  await invoke(jvm, thread, 'InstInline', 'drive', '([ILBase;I)I', [out, base, n]);
  const before = metaOf(jvm, 'InstInline.drive([ILBase;I)I');
  t.ok(before && before.speculations === 2, 'speculative module in place');

  await jvm.loadClassByName('Third');
  jvm.classInitializationState.set('Third', 'INITIALIZED');
  const third = { type: 'Third', fields: { 'Base.f': 2 } };
  await invoke(jvm, thread, 'InstInline', 'drive', '([ILBase;I)I', [out, third, n]);
  t.equal(out[0], expectedSum(102, n), 'Third receiver dispatches correctly');
  await invoke(jvm, thread, 'InstInline', 'drive', '([ILBase;I)I', [out, base, n]);
  t.equal(out[0], expectedSum(2, n), 'Base receiver still correct after the world grew');
  const after = metaOf(jvm, 'InstInline.drive([ILBase;I)I');
  t.ok(!after || !after.speculations || after.specEpoch === (jvm.classEpoch || 0),
    'no stale speculative module survives the epoch bump');
  t.end();
});

test('structured field caches: fills hit, putfield kills, runs stay fresh', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'InstInline', BIMORPHIC_SOURCE, ['Base', 'Sub']);
  const n = 5000;
  const out = [0];
  out.type = '[I';
  const base = { type: 'Base', fields: { 'Base.f': 100000 } };
  // s = sum of (f0 - i): wrong (n * f0) if the putfield fails to kill the cache
  await invoke(jvm, thread, 'InstInline', 'drain', '([ILBase;I)I', [out, base, n]);
  t.equal(out[0], (100000 * n - (n * (n - 1)) / 2) | 0, 'read-decrement loop is exact');
  t.equal(base.fields['Base.f'], 100000 - n, 'field visibly decremented');
  const meta = metaOf(jvm, 'InstInline.drain([ILBase;I)I');
  t.ok(meta && meta.structured, 'drain compiled by the structured backend');
  const caching = process.env.JVM_DISABLE_WASM_FIELD_CACHE !== '1';
  if (caching) t.ok(meta.fieldCacheCount >= 1, 'getfield registered a cache entry');
  else t.equal(meta.fieldCacheCount, 0, 'kill switch leaves no cache entries');

  // caches are per-run locals: a mutation between invokes must be seen
  base.fields['Base.f'] = 9;
  await invoke(jvm, thread, 'InstInline', 'drive', '([ILBase;I)I', [out, base, n]);
  t.equal(out[0], expectedSum(9, n), 'fresh run reads the mutated field');
  const drive = metaOf(jvm, 'InstInline.drive([ILBase;I)I');
  if (caching) t.ok(drive && drive.fieldCacheCount >= 1, 'inlined val() getfield is cached');
  t.end();
});

test('unrelated class load keeps the speculative module (no recompile)', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'InstInline', BIMORPHIC_SOURCE, ['Base', 'Sub']);
  const n = 5000;
  const out = [0];
  out.type = '[I';
  const base = { type: 'Base', fields: { 'Base.f': 6 } };
  await invoke(jvm, thread, 'InstInline', 'drive', '([ILBase;I)I', [out, base, n]);
  const before = metaOf(jvm, 'InstInline.drive([ILBase;I)I');
  t.ok(before && before.speculations === 2, 'speculative module in place');

  await jvm.loadClassByName('Unrelated');
  jvm.classInitializationState.set('Unrelated', 'INITIALIZED');
  await invoke(jvm, thread, 'InstInline', 'drive', '([ILBase;I)I', [out, base, n]);
  t.equal(out[0], expectedSum(6, n), 'result still correct after the unrelated load');
  const after = metaOf(jvm, 'InstInline.drive([ILBase;I)I');
  t.equal(after, before, 'same module object survives — no recompile');
  t.equal(after.specEpoch, jvm.classEpoch || 0, 'specEpoch refreshed to the new world');
  t.end();
});

const CHAIN_SOURCE = `
public class ChainInline {
  public static int drive(int[] out, H h, int n) {
    int s = 0;
    for (int i = 0; i < n; i++) s += h.hop();
    out[0] = s;
    return s;
  }
  public static void driveCce(int[] out, H h, int n) {
    int r;
    try { r = drive(out, h, n); } catch (ClassCastException e) { r = -7; }
    out[0] = r;
  }
}
class Leaf { int f; int val() { return f; } }
class H { Object l; int hop() { return ((Leaf) l).val() + 1; } }
`;

test('interior monomorphic chain with checkcast flattens into the caller', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'ChainInline', CHAIN_SOURCE, ['Leaf', 'H']);
  const n = 5000;
  const out = [0];
  out.type = '[I';
  const leaf = { type: 'Leaf', fields: { 'Leaf.f': 5 } };
  const h = { type: 'H', fields: { 'H.l': leaf } };
  await invoke(jvm, thread, 'ChainInline', 'drive', '([ILH;I)I', [out, h, n]);
  t.equal(out[0], (6 * n) | 0, 'getter chain result matches');

  const meta = metaOf(jvm, 'ChainInline.drive([ILH;I)I');
  t.ok(meta && meta.structured, 'drive compiled by the structured backend');
  t.ok(meta.inlinedCalls >= 1, 'chain call site was inlined');
  t.ok(meta.speculations >= 2, 'outer and interior guards recorded');

  const wrong = { type: 'H', fields: { 'H.l': { type: 'H', fields: {} } } };
  await invoke(jvm, thread, 'ChainInline', 'driveCce', '([ILH;I)V', [out, wrong, n]);
  t.equal(out[0], -7, 'failed checkcast throws the guest CCE from the cast import');
  t.end();
});

test('JVM_WASM_INSTANCE_INLINE=0 disables the instance path but stays correct', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'InstInline', BIMORPHIC_SOURCE, ['Base', 'Sub'],
    { JVM_WASM_INSTANCE_INLINE: '0' });
  const n = 5000;
  const out = [0];
  out.type = '[I';
  const sub = { type: 'Sub', fields: { 'Base.f': 4 } };
  await invoke(jvm, thread, 'InstInline', 'drive', '([ILBase;I)I', [out, sub, n]);
  t.equal(out[0], expectedSum(8, n), 'result matches with the flag off');
  const meta = metaOf(jvm, 'InstInline.drive([ILBase;I)I');
  t.ok(!meta || !meta.speculations, 'no speculative module with the flag off');
  t.end();
});

const WALK_SOURCE = `
public class ChainWalk {
  public static void chainSum(int[] out, Node h, int n) {
    int s = 0;
    for (int i = 0; i < n; i++) { s += h.v; h = h.next; }
    out[0] = s;
  }
}
class Node { int v; Node next; }
`;

test('loop-phi field receiver: cache refills as the walk advances', async (t) => {
  // h is a loop phi (h = h.next): the SSA value id backing the h.v cache is
  // rebound every iteration. Without the def-site kills, the cache filled on
  // node 0 survives the rebinding and every read returns the first node's v.
  const { jvm, thread } = await makeHarness(t, 'ChainWalk', WALK_SOURCE, ['Node']);
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
    await invoke(jvm, thread, 'ChainWalk', 'chainSum', '([ILNode;I)V', [out, head, n]);
  }
  t.equal(out[0], expect, 'walk reads each node’s field, not the first forever');
  t.ok(metaOf(jvm, 'ChainWalk.chainSum([ILNode;I)V'), 'chainSum is compiled');
  t.end();
});


const THIS_ELIDE_SOURCE = `
public class ThisElide {
  public static int drive(int[] out, Reader r, int n) {
    int s = 0;
    for (int i = 0; i < n; i++) { r.p = 0; s = (s * 31) + r.u16(); }
    out[0] = s;
    return s;
  }
  public static int drivePriv(int[] out, Reader r, int n) {
    int s = 0;
    for (int i = 0; i < n; i++) { s = (s * 31) + r.priv(); }
    out[0] = s;
    return s;
  }
}
class Reader {
  byte[] d;
  int p;
  int u8() { return d[p++] & 0xff; }
  int u16() { int h = u8(); return (h << 8) | u8(); }
  int priv() { return go(); }
  private int go() { return p + 11; }
}
class AltA extends Reader { int u16() { return 1; } int priv() { return 2; } }
class AltB extends Reader { int u16() { return 3; } int priv() { return 4; } }
class ReaderSub extends Reader { int u8() { return 7; } }
`;

// Three u16/priv impls keep the drive() sites out of the inliner, so the
// Reader callees compile as their own modules (the shapes under test).
const THIS_ELIDE_PRELOAD = ['Reader', 'AltA', 'AltB'];

function accum31(per, n) {
  let s = 0;
  for (let i = 0; i < n; i += 1) s = (Math.imul(s, 31) + per) | 0;
  return s;
}

test('`this` receivers elide inline guards: callee stays fully compiled', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'ThisElide', THIS_ELIDE_SOURCE, THIS_ELIDE_PRELOAD);
  const out = [0];
  out.type = '[I';
  const d = [0x12, 0x34, 0, 0];
  d.type = '[B';
  const reader = { type: 'Reader', fields: { 'Reader.d': d, 'Reader.p': 0 } };
  const n = 4000;
  await invoke(jvm, thread, 'ThisElide', 'drive', '([ILReader;I)I', [out, reader, n]);
  t.equal(out[0], accum31(0x1234, n), 'unpack loop result matches');
  const meta = metaOf(jvm, 'Reader.u16()I');
  t.ok(meta && meta.structured, 'u16 compiled by the structured backend');
  t.ok(meta.inlinedCalls >= 2, 'both u8 calls inlined');
  t.equal(meta.elidedThisGuards, 2, 'both guards elided for the `this` receiver');
  t.equal(meta.deoptStubCount, 0, 'no guard-miss deopt stubs remain');
  t.equal(meta.speculations, 0, 'no instanceof guards recorded');
  t.ok(meta.specSites && meta.specSites.length === 2, 'elided sites still record specSites');
  t.ok(meta.fullyCompiled, 'guard-elided module is fully compiled');
  t.end();
});

test('elided module invalidates when a later class overrides the target', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'ThisElide', THIS_ELIDE_SOURCE, THIS_ELIDE_PRELOAD);
  const out = [0];
  out.type = '[I';
  const d = [0x12, 0x34, 0, 0];
  d.type = '[B';
  const reader = { type: 'Reader', fields: { 'Reader.d': d, 'Reader.p': 0 } };
  const n = 4000;
  await invoke(jvm, thread, 'ThisElide', 'drive', '([ILReader;I)I', [out, reader, n]);
  const before = metaOf(jvm, 'Reader.u16()I');
  t.ok(before && before.fullyCompiled && before.specSites.length === 2,
    'elided speculative module in place');

  // ReaderSub overrides u8 but inherits u16: a ReaderSub receiver entering
  // the stale module would take the elided Reader.u8 pick and read the array
  // (0x1234) instead of dispatching the override (0x0707).
  await jvm.loadClassByName('ReaderSub');
  jvm.classInitializationState.set('ReaderSub', 'INITIALIZED');
  const sub = { type: 'ReaderSub', fields: { 'Reader.d': d, 'Reader.p': 0 } };
  await invoke(jvm, thread, 'ThisElide', 'drive', '([ILReader;I)I', [out, sub, n]);
  t.equal(out[0], accum31(0x0707, n),
    'ReaderSub receiver dispatches the override after the world grew');
  await invoke(jvm, thread, 'ThisElide', 'drive', '([ILReader;I)I', [out, reader, n]);
  t.equal(out[0], accum31(0x1234, n), 'Reader receiver still reads the array correctly');
  t.end();
});

test('private helper via invokespecial elides the null guard on `this`', async (t) => {
  const { jvm, thread } = await makeHarness(t, 'ThisElide', THIS_ELIDE_SOURCE, THIS_ELIDE_PRELOAD);
  const out = [0];
  out.type = '[I';
  const reader = { type: 'Reader', fields: { 'Reader.d': null, 'Reader.p': 30 } };
  const n = 4000;
  await invoke(jvm, thread, 'ThisElide', 'drivePriv', '([ILReader;I)I', [out, reader, n]);
  t.equal(out[0], accum31(41, n), 'private-helper loop result matches');
  const meta = metaOf(jvm, 'Reader.priv()I');
  t.ok(meta && meta.structured, 'priv compiled by the structured backend');
  t.equal(meta.elidedThisGuards, 1, 'guard on the private helper elided');
  t.equal(meta.deoptStubCount, 0, 'no deopt stub');
  t.ok(meta.fullyCompiled, 'guard-elided module fully compiled');
  // javac 11+ emits invokevirtual for private calls (nestmates), which
  // records one revalidation specSite; -source 8 fixtures emit
  // invokespecial, which records none. Both must elide guard-free.
  t.equal(meta.speculations, 0, 'no instanceof guards recorded');
  t.end();
});

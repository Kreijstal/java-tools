'use strict';
// A recorded preparation pass replayed into a fresh JVM must leave the JIT
// exactly where compiling would have: the same site tables entry by entry,
// the same prepared set, the same generated text, and the same results.
// This is what the development code pack (dekobloko-work code-pack.mjs)
// relies on to stand in for the browser's own ahead-of-main compiles.
const test = require('tape');
const {JVM} = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const CallStack = require('../src/core/callStack');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const {dropDiagnosticSource} = require('../src/jit/PreparedCodeCache');
const fixture = makeJavaFixtureCompiler('prepared-code-cache-replay-');
const identity = {runtime: 'replay-runtime', source: 'replay-source', patch: 'replay-patch',
  configuration: 'replay-config'};

const SOURCE = `public class PackProbe {
  static int bias;
  int x;
  PackProbe(int x) { this.x = x; }
  int get() { return x + bias; }
  static void fill(int[] a, int from, int to, int v) { for (int i = from; i < to; i++) a[i] = v + i; }
  static int sum(int[] a) { int s = 0; for (int i = 0; i < a.length; i++) s += a[i]; return s; }
  static int run(int n) {
    int[] a = new int[n];
    for (int r = 0; r < 4; r++) fill(a, 0, n, r);
    return sum(a) + make(n);
  }
  static int make(int k) { PackProbe p = new PackProbe(k); return p.get(); }
  static String name(int k) { return "probe" + k; }
}`;

const methodKey = (jvm, method) =>
  `${jvm.findClassNameForMethod(method)}.${method.name}${method.descriptor}`;

// Every id-indexed table entry by what it denotes, plus which methods are
// prepared and what text each published body carries.
function world(jvm) {
  const jit = jvm.jit;
  const methods = (jvm.classes.PackProbe.ast.classes[0].items || [])
    .filter(item => item.type === 'method').map(item => item.method);
  return {
    watermark: jit.siteIdWatermark(),
    directCheckedLeafBodies: jit.directCheckedLeafBodies.map(body => String(body)),
    syncCallSites: jit.syncCallSites.map((site, index) => site ? [site.op,
      site.declaredClassName, site.methodName, site.descriptor, site.callerPc,
      site.callerMethod ? methodKey(jvm, site.callerMethod) : null,
      site.id === index] : null),
    fieldSites: jit.fieldSites.map(site => site ? [site.className, site.fieldName] : null),
    directStaticTargets: jit.directStaticTargets.map(t => t ? [t.siteClassName, t.key] : null),
    guards: jit.structuredSsa.classInitializationGuards.map(g => g ? [...g.owners] : null),
    prepared: methods.filter(m => jit.preparedCodegenMethods.has(m)).map(m => methodKey(jvm, m)),
    bodies: methods.map(m => {
      const body = jit.codegenCache.get(m);
      // Entries leave out the diagnostic copies of source (dropDiagnosticSource),
      // so a compiled body is compared without them too.
      const payload = typeof body === 'function' ? jit.serializeGeneratedResult(body) : null;
      if (payload) dropDiagnosticSource(payload);
      return [methodKey(jvm, m), jit.codegenCache.has(m),
        payload ? JSON.stringify(payload, (key, value) =>
          key === 'provenance' || key === 'dropped' ? undefined : value) : String(body)];
    }),
  };
}

// Compare two worlds key by key, naming the first entry that differs.
function sameWorld(t, actual, expected, message) {
  const differences = [];
  for (const key of Object.keys(expected)) {
    const a = actual[key], e = expected[key];
    if (JSON.stringify(a) === JSON.stringify(e)) continue;
    if (Array.isArray(e) && Array.isArray(a)) {
      let index = 0;
      while (index < Math.max(a.length, e.length) &&
        JSON.stringify(a[index]) === JSON.stringify(e[index])) index++;
      const left = JSON.stringify(a[index]) ?? '', right = JSON.stringify(e[index]) ?? '';
      let at = 0;
      while (at < left.length && left[at] === right[at]) at++;
      differences.push(`${key}[${index}] at ${at}: ${left.slice(Math.max(0, at - 120), at + 200)} vs ` +
        `${right.slice(Math.max(0, at - 120), at + 200)}`);
    } else {
      differences.push(`${key}: ${JSON.stringify(a)} vs ${JSON.stringify(e)}`);
    }
  }
  t.equal(differences.join('\n'), '', message);
}

async function create(classpath) {
  const jvm = new JVM({classpath, jit: {compileWorker: false, structuredSsa: true,
    compiledCallChains: true, ordinaryAdaptiveFramelessPositional: true,
    preferWholeMethodJs: true, checkedLeafDirectPositional: true}});
  await jvm.loadClassByName('PackProbe');
  jvm.classInitializationState.set('PackProbe', 'INITIALIZED');
  jvm.classes.PackProbe.staticFields.set('bias:I', 5);
  return jvm;
}

function memoryStore(source = null) {
  const data = new Map();
  const stats = {gets: 0, served: 0, puts: 0};
  return {data, stats,
    get: async key => { stats.gets++; const text = source ? source.get(key) : undefined;
      if (text != null) stats.served++; return text; },
    put: async (key, text) => { stats.puts++; data.set(key, text); }};
}

async function prepare(jvm, store, extra = {}) {
  let compiles = 0;
  const compile = jvm.jit.compileMethod;
  jvm.jit.compileMethod = function (...args) { compiles++; return compile.apply(this, args); };
  const result = await jvm.precompileInitializedClasses({effectful: true, wasm: false,
    preparedCodeCache: {identity, store, dropDiagnosticSource: true,
      ignoreRetentionBudget: true, ...extra}});
  jvm.jit.compileMethod = compile;
  return {report: result.report, cache: result.report.preparedCache, compiles};
}

async function invokeRun(jvm, n) {
  const method = await jvm.findMethodInHierarchy('PackProbe', 'run', '(I)I');
  const body = jvm.jit.codegenCache.get(method);
  if (typeof body !== 'function') return null;
  const frame = new Frame(method);
  frame.className = 'PackProbe';
  frame.locals[0] = n;
  const thread = {status: 'runnable', callStack: new CallStack()};
  thread.callStack.push(frame);
  jvm._nextEventLoopYieldAt = Infinity;
  const result = body(frame, thread, jvm.jit, false);
  return result && result.value;
}

for (const requireCompleteResults of [false, true]) {
  test(`replayed preparation reproduces the compiled world (requireCompleteResults=${requireCompleteResults})`, async t => {
    const classpath = fixture(t, 'PackProbe', SOURCE);
    const options = {requireCompleteResults};

    const recorded = await create(classpath);
    const recordStore = memoryStore();
    const record = await prepare(recorded, recordStore, options);
    t.ok(record.cache.writes > 0, 'recording stores steps');
    t.equal(record.cache.writes + record.cache.unrecorded, record.cache.misses,
      'every step is stored or reported unrecorded');

    const replayed = await create(classpath);
    const replayStore = memoryStore(recordStore.data);
    const replay = await prepare(replayed, replayStore, options);
    t.equal(replay.cache.refused, 0, 'no stored step is refused');
    t.equal(replay.cache.hits, record.cache.writes, 'every stored step is restored');
    t.equal(replay.cache.misses, record.cache.unrecorded,
      'only the unrecorded steps compile again');
    t.ok(replay.compiles < record.compiles || record.cache.unrecorded === record.cache.misses,
      'replay compiles less than recording');
    sameWorld(t, world(replayed), world(recorded), 'site tables, prepared set and bodies match');
    t.equal(await invokeRun(replayed, 16), await invokeRun(recorded, 16),
      'replayed code computes what compiled code computes');

    // Compiling again with the same inputs writes byte-identical entries.
    const fresh = await create(classpath);
    const freshStore = memoryStore();
    await prepare(fresh, freshStore, options);
    t.deepEqual([...freshStore.data.keys()], [...recordStore.data.keys()], 'same steps');
    t.ok([...freshStore.data].every(([key, text]) => recordStore.data.get(key) === text),
      'every entry is byte-identical to a fresh compile under the same key');
    t.end();
  });
}

test('a mismatched or damaged pack falls back to compiling', async t => {
  const classpath = fixture(t, 'PackProbe', SOURCE);
  const recorded = await create(classpath);
  const recordStore = memoryStore();
  await prepare(recorded, recordStore);
  const expected = await invokeRun(recorded, 9);

  // Another identity: nothing matches, everything compiles, same world.
  const other = await create(classpath);
  const otherStore = memoryStore(recordStore.data);
  const otherRun = await other.precompileInitializedClasses({effectful: true, wasm: false,
    preparedCodeCache: {identity: {...identity, runtime: 'other-runtime'}, store: otherStore,
      dropDiagnosticSource: true, ignoreRetentionBudget: true}});
  t.equal(otherRun.report.preparedCache.hits, 0, 'a different identity restores nothing');
  sameWorld(t, world(other), world(recorded), 'the fallback compiles the same world');
  t.equal(await invokeRun(other, 9), expected, 'fallback computes the same result');

  // A damaged entry part way: refused, replay stops, the rest compiles.
  const keys = [...recordStore.data.keys()];
  const damaged = new Map(recordStore.data);
  const victim = keys[Math.floor(keys.length / 2)];
  const entry = JSON.parse(damaged.get(victim));
  entry.before.fieldSites += 1;
  damaged.set(victim, JSON.stringify(entry));
  const partial = await create(classpath);
  const run = await prepare(partial, memoryStore(damaged));
  t.equal(run.cache.refused, 1, 'the damaged entry is refused');
  t.ok(run.cache.hits < keys.length, 'replay stops at the refusal');
  t.equal(await invokeRun(partial, 9), expected, 'a partial replay computes the same result');
  t.end();
});


test('a worker reservation cannot hide direct checked-leaf allocations', async t => {
  const classpath = fixture(t, 'PackProbe', SOURCE);
  const sender = await create(classpath);
  await prepare(sender, memoryStore(), {requireCompleteResults: true});
  const prefix = sender.jit.siteIdWatermark();
  t.ok(prefix.directCheckedLeafBodies > 0, 'real checked-leaf calls allocate the table');
  const worker = await create(classpath);
  worker.jit.reserveSiteIdSpace(prefix);
  t.equal(worker.jit.directCheckedLeafBodies.length, prefix.directCheckedLeafBodies,
    'the worker reserves the sender prefix without inventing callable entries');
  const caller = await worker.findMethodInHierarchy('PackProbe', 'run', '(I)I');
  worker.jit.getGeneratedFunction(caller, {allowEffectfulCalls: true, compileLocally: true});
  t.ok(worker.jit.directCheckedLeafBodies.length > prefix.directCheckedLeafBodies,
    'new callable entries allocate beyond the reserved prefix');
  t.ok(worker.jit.untransportableTableGrowth(prefix).includes('directCheckedLeafBodies'),
    'the result is refused rather than addressing unrelated receiver entries');
  t.end();
});

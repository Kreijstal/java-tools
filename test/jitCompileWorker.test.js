// Phase 1.2 of docs/plan-linear-runtime.md, end to end: a real worker_threads
// worker boots its own JVM, compiles on request, and returns plain data the
// main JIT rebuilds and publishes. While a body is being built the method
// keeps running interpreted -- the main thread never compiles it.
const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JVM } = require('../src/core/jvm');
const frontend = require('../src/java-frontend');

function compileProbe(t, prefix) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.teardown(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  frontend.compileJavaFile(
    path.resolve(__dirname, '../sources/HotnessProbe.java'),
    { outputDir, sourceFileName: 'HotnessProbe.java' });
  return outputDir;
}

// These tests must exercise the path the worker actually serves: methods
// compiled AFTER main(). Ahead-of-main preparation deliberately compiles on
// the main thread (see _precompileInitializedClasses), so with it left on a
// small probe is fully compiled before the guest starts and the worker is
// correctly handed nothing. Skipping preparation is what puts compilation back
// on the running guest's path, where the worker belongs.
const WORKER_JIT = {
  profileMethods: true, compileWorker: true, warmupThreshold: 0,
};

function capture(jvm) {
  let out = '';
  jvm.registerJreMethods({ 'java/io/PrintStream': {
    'println(I)V': (_j, _o, args) => { out += `${args[0]}\n`; } } });
  return () => out;
}

test('a worker thread compiles and the main thread installs the result',
  async (t) => {
  const classpath = compileProbe(t, 'jit-worker-');

  const plain = new JVM({ classpath, jit: { profileMethods: true } });
  const plainOut = capture(plain);
  await plain.run('HotnessProbe');

  const jvm = new JVM({ classpath, prepareBeforeMain: false,
    jit: { ...WORKER_JIT } });
  const out = capture(jvm);
  t.teardown(() => jvm.jit.compileWorker.dispose());
  await jvm.run('HotnessProbe');
  await jvm.jit.compileWorker.whenIdle();

  const stats = jvm.jit.compileWorker.stats;
  t.ok(stats.queued > 0, 'the main thread queued methods instead of compiling');
  t.ok(stats.requested > 0, 'requests reached the worker');
  t.ok(stats.installed > 0,
    `a worker-built body was installed (${JSON.stringify(stats)}, last: ${
      jvm.jit.compileWorker.lastRefusal})`);
  t.equal(out(), plainOut(),
    'the program produces the same output as an ordinary run');
  t.end();
});

test('each in-flight request gets a disjoint id grant', async (t) => {
  const classpath = compileProbe(t, 'jit-worker-grant-');
  const jvm = new JVM({ classpath, prepareBeforeMain: false,
    jit: { ...WORKER_JIT, compileWorkerGrantStride: 64 } });
  t.teardown(() => jvm.jit.compileWorker.dispose());
  capture(jvm);
  const before = jvm.jit.siteIdWatermark().syncCallSites;
  await jvm.run('HotnessProbe');
  await jvm.jit.compileWorker.whenIdle();
  const requested = jvm.jit.compileWorker.stats.requested;
  t.ok(requested > 0, 'at least one request was granted a range');
  t.ok(jvm.jit.siteIdWatermark().syncCallSites >= before + 64 * requested,
    'every request reserved its own stride, so no two can collide');
  t.end();
});

test('a body arrives through the transport protocol, not a local compile',
  async (t) => {
  const classpath = compileProbe(t, 'jit-worker-transport-');
  const jvm = new JVM({ classpath, prepareBeforeMain: false,
    jit: { ...WORKER_JIT } });
  t.teardown(() => jvm.jit.compileWorker.dispose());
  capture(jvm);
  await jvm.run('HotnessProbe');
  await jvm.jit.compileWorker.whenIdle();
  const installed = jvm.jit.compileWorker.stats.installed;
  // codegenCache is a WeakMap, so ask it about the methods themselves.
  const items = jvm.classes.HotnessProbe?.ast?.classes?.[0]?.items || [];
  const cached = items.filter((item) => item.method &&
    jvm.jit.codegenCache.has(item.method)).length;
  t.ok(installed > 0, 'the worker installed bodies');
  t.ok(cached >= installed,
    'every installed body is in the ordinary codegen cache');
  t.equal(jvm.jit.compileWorker.stats.refused, 0,
    'no request was refused');
  t.end();
});

// The seed pass reads one thing to decide who compiles: whether the guest has
// started. Both sides of that boundary are tested, because "effectful" and
// "before main()" are different properties and only the second one is the
// measurement contract's rule.
async function seedProbe(t, prefix, { guestStarted }) {
  const classpath = compileProbe(t, prefix);
  const jvm = new JVM({ classpath, prepareBeforeMain: false,
    jit: { ...WORKER_JIT } });
  t.teardown(() => jvm.jit.compileWorker.dispose());
  capture(jvm);
  await jvm.loadClassByName('HotnessProbe');
  jvm.classInitializationState.set('HotnessProbe', 'INITIALIZED');
  if (guestStarted) {
    // What jvm.run() does when it hands control to guest code.
    jvm.guestStarted = true;
    jvm.jit.markMainStarted();
  }
  await jvm.precompileInitializedClasses({ initializedOnly: true });
  return jvm;
}

function probeMethods(jvm) {
  const items = jvm.classes.HotnessProbe?.ast?.classes?.[0]?.items || [];
  return items.map((item) => item.method).filter(Boolean);
}

test('a seed before main() compiles on the calling thread', async (t) => {
  // Preparation is free by the contract, and routing it through the worker
  // only made the main thread wait for a thread with nothing to overlap
  // (docs/refactor.md A.9). So this pass compiles here and queues nothing.
  const jvm = await seedProbe(t, 'jit-worker-seed-pre-', { guestStarted: false });
  t.equal(jvm.jit.compileWorker.stats.queued, 0,
    'nothing was handed to the worker before main()');
  const compiled = probeMethods(jvm)
    .filter((method) => jvm.jit.codegenCache.has(method)).length;
  t.ok(compiled >= 3,
    `preparation left the methods compiled (${compiled})`);
  t.end();
});

test('a seed after main() queues every method instead of compiling it',
  async (t) => {
  // 1.3: seed the queue with every method of every loaded class in
  // class-load order. The existing preparation path already walks exactly
  // that set, and once the guest is running each visit queues instead of
  // compiling -- this thread must not stop to optimize.
  const jvm = await seedProbe(t, 'jit-worker-seed-', { guestStarted: true });
  const queuedDuringSeed = jvm.jit.compileWorker.stats.queued;
  t.ok(queuedDuringSeed >= 3,
    `the seed queued the class's methods (${queuedDuringSeed})`);
  t.equal(jvm.jit.syncCompileCensus().postMainSyncCompileCount, 0,
    'the seed compiled nothing on the calling thread');

  await jvm.jit.compileWorker.whenIdle();
  t.ok(jvm.jit.compileWorker.stats.installed > 0,
    'the seeded methods came back as installed bodies');
  t.equal(jvm.jit.compileWorker.stats.failed, 0, 'no request failed to send');
  t.end();
});

test('hotness decides which queued method the worker builds next', (t) => {
  // The scores only exist while the sampler is on; without it the queue is
  // deliberately first-come, which the client documents.
  const jvm = new JVM({ jit: {
    compileWorker: true, hotness: true, hotnessTickMs: 0, hotnessTopN: 0 } });
  t.teardown(() => jvm.jit.compileWorker.dispose());
  const client = jvm.jit.compileWorker;
  const cold = { name: 'cold', descriptor: '()V', flags: ['static'] };
  const hot = { name: 'hot', descriptor: '()V', flags: ['static'] };
  client.queue.push({ method: cold, className: 'X' },
    { method: hot, className: 'X' });
  jvm.jit.recordHotness(cold, 1);
  jvm.jit.recordHotness(hot, 99);
  t.equal(client.nextRequest().method, hot,
    'the hottest queued method is requested first, not the oldest');
  t.equal(client.nextRequest().method, cold, 'the colder one follows');
  t.end();
});

// The regression these four cover: on a real boot every one of them was live
// at once, the suite stayed green, and dekobloko went from a 66 s boot to a
// 180 s timeout with 8467 of 8547 requests refused.

test('a class that cannot be cloned is quarantined, not silently swallowed',
  async (t) => {
  const classpath = compileProbe(t, 'jit-worker-poison-');

  const plain = new JVM({ classpath, jit: { profileMethods: true } });
  const plainOut = capture(plain);
  await plain.run('HotnessProbe');

  const jvm = new JVM({ classpath, prepareBeforeMain: false,
    jit: { ...WORKER_JIT } });
  const out = capture(jvm);
  t.teardown(() => jvm.jit.compileWorker.dispose());
  await jvm.loadClassByName('HotnessProbe');
  // Structured clone is all-or-nothing: one uncloneable class used to cost
  // the whole batch, and because the batch was marked delivered before the
  // send, none of those classes was ever offered again.
  const poisoned = Object.keys(jvm.classes).find(
    (name) => jvm.classes[name]?.ast && name !== 'HotnessProbe');
  t.ok(poisoned, 'a class other than the entry point is loaded');
  jvm.classes[poisoned].ast.jvmUncloneableProbe = () => {};

  await jvm.run('HotnessProbe');
  await jvm.jit.compileWorker.whenIdle();

  const client = jvm.jit.compileWorker;
  t.ok(client.unsendableClasses.has(poisoned),
    `the uncloneable class alone is quarantined (${
      [...client.unsendableClasses].join(', ')})`);
  t.ok(client.stats.installed > 0,
    `the other classes still cross and their bodies install (${
      JSON.stringify(client.stats)}, last: ${client.lastRefusal})`);
  t.equal(out(), plainOut(), 'the program still produces identical output');
  t.end();
});

test('a method the worker refuses is compiled on the main thread instead',
  async (t) => {
  const classpath = compileProbe(t, 'jit-worker-refused-');
  const jvm = new JVM({ classpath, prepareBeforeMain: false,
    jit: { ...WORKER_JIT } });
  capture(jvm);
  t.teardown(() => jvm.jit.compileWorker.dispose());
  await jvm.loadClassByName('HotnessProbe');
  // Quarantining a class that is ON the classpath no longer refuses anything:
  // the worker loads it itself (preloadClasspathClasses/mirrorClass), which is
  // the point of that change. A genuinely unmirrorable method needs a class
  // the worker can obtain by neither route - absent from its classpath, and
  // marked unsendable so it never crosses as class data. A refused method must
  // not be re-queued forever, and must not stay interpreted for the whole run.
  const ghost = 'GhostProbe';
  const method = {
    className: ghost, name: 'add', descriptor: '(II)I', flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: ['iload_0', 'iload_1', 'iadd', 'ireturn']
        .map((instruction, index) => ({ labelDef: `L${index}:`, instruction })),
      localsSize: '2', stackSize: '2', exceptionTable: [],
    } }],
  };
  jvm.classes[ghost] = {
    staticFields: new Map(),
    ast: { classes: [{ className: ghost, superClassName: 'java/lang/Object',
      items: [{ type: 'method', method }] }] },
  };
  jvm.classInitializationState.set(ghost, 'INITIALIZED');
  const client = jvm.jit.compileWorker;
  client.unsendableClasses.add(ghost);

  t.ok(client.enqueue(method, {}), 'the unmirrorable method is queued');
  await client.whenIdle();

  t.ok(client.stats.refused > 0,
    `the worker refused the unmirrored method (${
      JSON.stringify(client.stats)}, last: ${client.lastRefusal})`);
  t.ok(client.declined.has(method),
    'the refused method is retired, not re-queued');
  // The fallback is the ordinary path, not a second mechanism: the next time
  // anything asks for the body, the main thread compiles it itself. Before
  // the fix `enqueue` kept claiming the method and it stayed interpreted for
  // the rest of the run, however hot it got.
  //
  // This is the BEFORE-main() rule. `main()` has not started here, so there is
  // no guest to stall and compiling on this thread is free. Once it has, a
  // refusal must not authorize a synchronous compile -- see
  // test/jitPostMainSyncCompile.test.js for the other half.
  t.notOk(client.enqueue(method, {}), 'a retired method is never queued again');
  t.ok(jvm.jit.getGeneratedFunction(method),
    'asking again compiles the retired method on the main thread');
  t.end();
});

test('a send that throws consumes no id space and delivers no class',
  async (t) => {
  const classpath = compileProbe(t, 'jit-worker-nosend-');
  const jvm = new JVM({ classpath, prepareBeforeMain: false,
    jit: { ...WORKER_JIT } });
  t.teardown(() => jvm.jit.compileWorker.dispose());
  await jvm.loadClassByName('HotnessProbe');
  const client = jvm.jit.compileWorker;
  // Reserving the grant before the send leaked 512 ids per table per failed
  // request; a real boot reached 4.4 million syncCallSites entries this way.
  client.ensureWorker = () => ({ postMessage() {
    throw new Error('nothing crosses'); }, ref() {}, unref() {} });

  const before = jvm.jit.siteIdWatermark();
  const method = jvm.classes['HotnessProbe'].ast.classes[0].items
    .find((item) => item?.type === 'method')?.method;
  t.ok(method, 'the probe class has a method to queue');
  client.enqueue(method, {});

  const after = jvm.jit.siteIdWatermark();
  t.equal(after.syncCallSites, before.syncCallSites,
    'a failed send reserved no call-site ids');
  t.equal(after.fieldSites, before.fieldSites,
    'a failed send reserved no field-site ids');
  t.equal(client.sentClasses.size, 0,
    'no class is recorded as delivered by a send that threw');
  t.end();
});

test('a re-asked method overtakes the precompile seeds queued ahead of it',
  async (t) => {
  const classpath = compileProbe(t, 'jit-worker-demand-');
  const jvm = new JVM({ classpath, prepareBeforeMain: false,
    jit: { ...WORKER_JIT } });
  t.teardown(() => jvm.jit.compileWorker.dispose());
  await jvm.loadClassByName('HotnessProbe');
  const client = jvm.jit.compileWorker;
  // precompileInitializedClasses walks every method of every loaded class, so
  // a FIFO queue puts thousands of cold seeds ahead of whatever the guest is
  // actually running.
  const seeds = [{ method: { name: 'seedA' } }, { method: { name: 'seedB' } }];
  const wanted = { method: { name: 'wanted' } };
  client.queue.push(seeds[0], seeds[1], wanted);
  for (const entry of [...seeds, wanted]) client.queued.add(entry.method);
  client.demand.set(seeds[0].method, 1);
  client.demand.set(seeds[1].method, 1);
  client.demand.set(wanted.method, 1);
  client.enqueue(wanted.method, {});
  client.enqueue(wanted.method, {});

  t.equal(client.nextRequest().method.name, 'wanted',
    'the method asked for repeatedly is compiled first');
  t.end();
});

// A stale result and a refusal are not the same event, and after main() the
// difference decides whether a method keeps a tier or loses one for good.
// A refusal is a verdict: the worker looked at the method and cannot build it,
// so asking again is waste. Staleness is a lost race: the body was built
// against a site table or static target that moved before it landed, and the
// same request may well succeed next time. Treating the second like the first
// retired a hot method on one lost race -- and after main() nobody else will
// build it, so it ran in whatever tier it happened to hold for the rest of
// the run. 1.5 asks for bounded retries, which means neither unbounded nor
// zero.
function stubbedWorkerClient(t, prefix) {
  const classpath = compileProbe(t, prefix);
  const jvm = new JVM({ classpath, prepareBeforeMain: false,
    jit: { ...WORKER_JIT } });
  t.teardown(() => jvm.jit.compileWorker.dispose());
  const client = jvm.jit.compileWorker;
  const sent = [];
  // Never spawn: these tests are about what the client does with a reply, and
  // a real worker would answer for itself.
  client.ensureWorker = () => {
    client.worker = { ref() {}, unref() {}, terminate() {} };
    return { postMessage: (message) => sent.push(message) };
  };
  return { jvm, client, sent };
}

test('a stale result is retried once before the method is retired',
  async (t) => {
  const { jvm, client, sent } = stubbedWorkerClient(t, 'jit-worker-stale-');
  const method = {
    className: 'StaleProbe', name: 'add', descriptor: '(II)I',
    flags: ['static'], attributes: [{ type: 'code', code: {
      codeItems: ['iload_0', 'iload_1', 'iadd', 'ireturn'].map(
        (instruction, index) => ({ labelDef: `L${index}:`, instruction })),
      localsSize: '2', stackSize: '2', exceptionTable: [] } }],
  };
  jvm.classes.StaleProbe = { staticFields: new Map(), ast: { classes: [{
    className: 'StaleProbe', superClassName: 'java/lang/Object',
    items: [{ type: 'method', method }] }] } };

  // Every arriving body fails to rebuild, which is exactly what the launcher
  // observed as `cannot-intern-static-target`.
  jvm.jit.materializeGeneratedResult = () => null;

  t.ok(client.enqueue(method, {}), 'the worker takes the method');
  t.equal(sent.length, 1, 'and one request went out');

  client.receive({ type: 'result', id: sent[0].id, payload: {} });
  t.equal(client.stats.stale, 1, 'the first result is counted stale');
  t.equal(client.stats.staleRetried, 1, 'and it was retried, not retired');
  t.notOk(client.declined.has(method),
    'the method is still the worker\'s problem');
  t.equal(sent.length, 2, 'the retry was actually sent');

  client.receive({ type: 'result', id: sent[1].id, payload: {} });
  t.equal(client.stats.stale, 2, 'the second result is stale too');
  t.equal(client.stats.staleRetried, 1, 'and there is no second retry');
  t.ok(client.declined.has(method), 'now the method is retired');
  t.ok(client.declinedByRefusal.has(method),
    'as a refusal, so after main() it keeps its tier instead of stalling');
  t.equal(sent.length, 2, 'nothing further was sent');
  t.end();
});

test('a stranded hot method is counted once as a method, not once per ask',
  async (t) => {
  const { jvm, client } = stubbedWorkerClient(t, 'jit-worker-strand-');
  const method = {
    className: 'StrandProbe', name: 'add', descriptor: '(II)I',
    flags: ['static'], attributes: [{ type: 'code', code: {
      codeItems: ['iload_0', 'iload_1', 'iadd', 'ireturn'].map(
        (instruction, index) => ({ labelDef: `L${index}:`, instruction })),
      localsSize: '2', stackSize: '2', exceptionTable: [] } }],
  };
  client.decline(method, { refused: true });
  jvm.guestStarted = true;
  jvm.jit.markMainStarted();

  const before = jvm.jit.syncCompileCensus();
  for (let ask = 0; ask < 5; ask += 1) {
    t.equal(jvm.jit.getGeneratedFunction(method), null,
      'the guest keeps running the tier it has');
  }
  const after = jvm.jit.syncCompileCensus();
  t.equal(after.workerUnservedPostMainCount -
    before.workerUnservedPostMainCount, 5, 'five asks are five asks');
  t.equal(after.workerUnservedPostMainMethodCount -
    before.workerUnservedPostMainMethodCount, 1,
    'but only one method is actually stranded');
  t.end();
});

// The acceptance target is a browser, and a browser has no `worker_threads`.
// Until now `ensureWorker` required it outright, so on the one host the fps
// objective is actually stated for, every send threw and the entire mechanism
// of Phase 1 -- compiling somewhere other than the thread running the guest --
// was absent. These pin the browser half, which no other test reaches.
function fakeBrowserWorker(t, { url }) {
  const sent = [];
  const listeners = new Map();
  let terminated = false;
  class FakeWorker {
    constructor(scriptUrl, options) {
      this.scriptUrl = scriptUrl;
      this.options = options;
    }
    postMessage(message) { sent.push(message); }
    addEventListener(event, callback) { listeners.set(event, callback); }
    terminate() { terminated = true; }
  }
  const hadWorker = 'Worker' in globalThis;
  const previous = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  if (url) globalThis.JVM_COMPILE_WORKER_URL = url;
  t.teardown(() => {
    if (hadWorker) globalThis.Worker = previous;
    else delete globalThis.Worker;
    delete globalThis.JVM_COMPILE_WORKER_URL;
  });
  return { sent, listeners, isTerminated: () => terminated };
}

test('a browser host builds a Web Worker and hands it its configuration',
  async (t) => {
  const classpath = compileProbe(t, 'jit-worker-browser-');
  const jvm = new JVM({ classpath, prepareBeforeMain: false,
    jit: { ...WORKER_JIT } });
  t.teardown(() => jvm.jit.compileWorker.dispose());
  const client = jvm.jit.compileWorker;
  const fake = fakeBrowserWorker(t, { url: '/dist/jvm-compile-worker.js' });

  const host = client.createBrowserWorkerHost();
  t.ok(host, 'a host is built from globalThis.Worker');
  t.equal(host.kind, 'web-worker', 'and it identifies itself as one');
  // `workerData` has no browser equivalent, so the configuration has to be
  // the first message -- before any compile request, or the worker builds its
  // JVM without a classpath and refuses everything it is asked.
  t.equal(fake.sent.length, 1, 'exactly one message was sent up front');
  t.equal(fake.sent[0].type, 'init', 'and it is the configuration');
  t.equal(fake.sent[0].classpath, jvm.classpath,
    'carrying the classpath the main thread is running');

  // A browser worker cannot keep a page alive and cannot let it exit between
  // a send and its reply, so these must be harmless rather than absent.
  t.doesNotThrow(() => { host.ref(); host.unref(); },
    'ref and unref are no-ops rather than missing methods');

  let delivered = null;
  host.onMessage((message) => { delivered = message; });
  fake.listeners.get('message')({ data: { type: 'ready' } });
  t.deepEqual(delivered, { type: 'ready' },
    'a MessageEvent is unwrapped to the payload the protocol expects');

  let failure = null;
  host.onError((error) => { failure = error; });
  fake.listeners.get('error')({ message: 'boom' });
  t.equal(failure.message, 'boom', 'an ErrorEvent becomes an Error');

  await host.terminate();
  t.ok(fake.isTerminated(), 'terminate reaches the worker');
  t.end();
});

test('a browser with no worker script configured falls back cleanly',
  async (t) => {
  const classpath = compileProbe(t, 'jit-worker-nourl-');
  const jvm = new JVM({ classpath, prepareBeforeMain: false,
    jit: { ...WORKER_JIT } });
  t.teardown(() => jvm.jit.compileWorker.dispose());
  const client = jvm.jit.compileWorker;
  fakeBrowserWorker(t, { url: null });

  // Not a failure: only the page knows where its bundle lives, and a page
  // that has not said must compile the way it always did rather than lose
  // every method to a worker that cannot be built.
  t.equal(client.createBrowserWorkerHost(), null,
    'no script URL means no browser host');
  t.end();
});

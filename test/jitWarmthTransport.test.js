// Warmth transport (docs/plan-linear-runtime.md, Phase 1.2 link state).
//
// A compile result that crosses from another JIT as plain data used to land
// with COLD call sites, twice over: every body of the result (framed,
// positional, resume) re-registered its own copy of each bytecode site, so
// the link the framed body learned on the first call was invisible to the
// positional entry the second call took; and nothing the requester had
// learned by running the method reached the worker or came back with the
// body. Three things fix that and are tested here in order:
//   1. a link record crosses with its site id, so one bytecode site is one
//      record on the receiver, shared by every body of the result;
//   2. the request carries the requester's learned link state, and the
//      worker seeds it into the sites it registers while compiling;
//   3. on arrival the receiver pre-links a fresh site from its own cache,
//      using the receiver types the requester learned.
'use strict';

const test = require('tape');
const { makeJavaFixtureCompiler } = require('./javaFixture');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');

const compileJavaFixture = makeJavaFixtureCompiler('jit-warmth-');
const JIT = {
  compileWorker: false, warmupThreshold: 0, profileMethods: false,
  preferWholeMethodJs: true, structuredSsa: true,
};

async function bootFixture(classpath, classNames, jit) {
  const jvm = new JVM({ classpath, jit });
  for (const className of classNames) {
    await jvm.loadClassByName(className);
    jvm.classInitializationState.set(className, 'INITIALIZED');
  }
  return jvm;
}

function makeThread(name) {
  return { id: 0, name, status: 'runnable', pendingException: null,
    callStack: new Stack() };
}

function runGenerated(jvm, generated, className, method, locals) {
  const frame = new Frame(method);
  frame.className = className;
  frame.locals.splice(0, locals.length, ...locals);
  const thread = makeThread('warmth-test');
  thread.callStack.push(frame);
  const result = generated(frame, thread, jvm.jit, false);
  // A whole-method body reports its return as {returned, value}.
  return result && typeof result === 'object' && result.returned === true
    ? result.value : result;
}

const LOOP_FIXTURE = `
public class WarmthLoop {
  private static int transform(int value) { return (value * 13 + 7) & 255; }
  private static void store(int[] destination, int index, int value) {
    destination[index] = value;
  }
  private static void fill(int[] destination, int start, int count, int seed) {
    for (int index = 0; index < count; index++) {
      store(destination, start + index, transform(seed + index));
    }
  }
  static void invoke(int[] destination, int start, int count, int seed) {
    fill(destination, start, count, seed);
  }
}
`;

test('every body of a transported result binds the same call-site record',
  async (t) => {
    const classpath = compileJavaFixture(t, 'WarmthLoop', LOOP_FIXTURE);
    const jvm = await bootFixture(classpath, ['WarmthLoop'],
      { ...JIT, shadowCompile: true });
    const jit = jvm.jit;
    t.ok(jit.shadowCompiler.enabled, 'the shadow compiler stands in for a worker');
    const caller = await jvm.findMethodInHierarchy('WarmthLoop', 'invoke', '([IIII)V');
    const fill = await jvm.findMethodInHierarchy('WarmthLoop', 'fill', '([IIII)V');

    const generated = jit.structuredSsa.compile(caller);
    t.ok(generated?.jvmStructuredSsa, 'the caller selects structured SSA');
    const destination = new Array(16).fill(-1);
    destination.type = '[I';
    // The resolving run: generic dispatch links invoke->fill, and inside the
    // transported body of fill, links fill->store.
    runGenerated(jvm, generated, 'WarmthLoop', caller, [destination, 2, 6, 10]);
    t.deepEqual(destination.slice(2, 8),
      Array.from({ length: 6 }, (_u, i) => ((10 + i) * 13 + 7) & 255),
      'the resolving run computes the guest result');
    t.ok(jit.shadowCompiler.stats.transported >= 1,
      `fill arrived through the transport (${jit.shadowCompiler.stats.transported} transported)`);

    const fillGenerated = jit.codegenCache.get(fill);
    const positional = fillGenerated?.jvmRestoringDirectPositionalBody;
    t.equal(typeof positional, 'function',
      'the transported callee carries its restoring positional entry');
    // 1. identity: the framed body and the positional entry name the same
    // record for the store() site, and it is one object on this JIT.
    const storeIds = (fn) => Object.entries(fn.jvmCaptureDescriptors || {})
      .filter(([, d]) => d.kind === 'callSite' && d.methodName === 'store')
      .map(([, d]) => d.id);
    const framedIds = storeIds(fillGenerated.jvmStructuredFramedBody || fillGenerated);
    const positionalIds = storeIds(positional);
    t.ok(framedIds.length && positionalIds.length,
      `both bodies capture the store() site (${framedIds} / ${positionalIds})`);
    t.deepEqual(framedIds, positionalIds,
      'the descriptors carry the same site id');
    const record = jit.syncCallSites[framedIds[0]];
    t.ok(record && record.fastPositional,
      'the record was warmed by the resolving run');

    // The observable consequence: the second call takes the positional
    // entry of fill, whose store() site must be the warm one.
    const generic = jit.tryInvokeSyncAtSite;
    jit.tryInvokeSyncAtSite = () => {
      throw new Error('generic dispatch ran for a warmed transported site');
    };
    let error = null;
    try {
      runGenerated(jvm, generated, 'WarmthLoop', caller, [destination, 0, 2, 30]);
    } catch (thrown) {
      error = thrown;
    } finally {
      jit.tryInvokeSyncAtSite = generic;
    }
    t.error(error, 'the warmed call completes without generic dispatch');
    t.deepEqual(destination.slice(0, 2), [141, 154],
      'and computes the exact Java result');
    t.end();
  });

const VIRTUAL_FIXTURE = `
public class WarmthShapes {
  static abstract class Shape { abstract int area(int k); }
  static final class Square extends Shape { int area(int k) { return k * k; } }
  static final class Wide extends Shape { int area(int k) { return k * 2; } }
  // An array write keeps bias() a synchronous helper with a call site of
  // its own rather than an inlined integer leaf.
  static int bias(int[] table, int k) {
    table[k & 3] += 1;
    return table[k & 3] + k;
  }
  static int sum(Shape shape, int[] table, int n) {
    int acc = 0;
    for (int i = 0; i < n; i++) acc += shape.area(i) + bias(table, i);
    return acc;
  }
}
`;
const SHAPE_CLASSES = ['WarmthShapes', 'WarmthShapes$Shape',
  'WarmthShapes$Square', 'WarmthShapes$Wide'];

function newTable() {
  const table = [0, 0, 0, 0];
  table.type = '[I';
  return table;
}

// The guest result of sum(shape, table, n) for a fresh table.
function expectedSum(area, n) {
  const table = [0, 0, 0, 0];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    table[i & 3] += 1;
    acc += area(i) + table[i & 3] + i;
  }
  return acc;
}

function newShape(className) {
  return { type: className, _className: className, fields: {} };
}

test('the request carries learned link state and the worker plans against it',
  async (t) => {
    const classpath = compileJavaFixture(t, 'WarmthShapes', VIRTUAL_FIXTURE);
    // The requester: runs sum() with a Square receiver so its sites learn.
    const requester = await bootFixture(classpath, SHAPE_CLASSES, JIT);
    const sum = await requester.findMethodInHierarchy('WarmthShapes', 'sum',
      '(LWarmthShapes$Shape;[II)I');
    const generated = requester.jit.getGeneratedFunction(sum);
    t.ok(generated, 'the requester compiled sum() locally');
    const result = runGenerated(requester, generated, 'WarmthShapes', sum,
      [newShape('WarmthShapes$Square'), newTable(), 8]);
    t.equal(result, expectedSum((i) => i * i, 8), 'the run computes the guest result');

    const warmth = requester.jit.describeCallSiteWarmth(sum);
    t.ok(Array.isArray(warmth) && warmth.length >= 1,
      `the requester describes its learned link state (${warmth?.length} sites)`);
    const virtual = warmth.find((entry) => entry.op === 'invokevirtual');
    t.ok(virtual, 'the virtual site learned something');
    t.equal(virtual.monomorphicReceiver, 'WarmthShapes$Square',
      'it records the receiver type the site resolved to');
    t.deepEqual(virtual.receivers.map((r) => r.type), ['WarmthShapes$Square'],
      'and the inline cache entry');
    t.deepEqual(virtual.receivers[0].method,
      { className: 'WarmthShapes$Square', name: 'area', descriptor: '(I)I' },
      'naming the method it resolved to, symbolically');
    const bias = warmth.find((entry) => entry.methodName === 'bias');
    t.ok(bias && bias.linked, 'the static site records its positional link');
    const crossed = JSON.parse(JSON.stringify(warmth));

    // The worker: a separate JVM that never ran anything.
    const worker = await bootFixture(classpath, SHAPE_CLASSES, JIT);
    const workerSum = await worker.findMethodInHierarchy('WarmthShapes', 'sum',
      '(LWarmthShapes$Shape;[II)I');
    t.notEqual(workerSum, sum, 'the worker has its own method object');
    worker.jit.seedTransportedWarmth(workerSum, crossed);
    const workerGenerated = worker.jit.getGeneratedFunction(workerSum);
    t.ok(workerGenerated, 'the worker compiled sum()');
    worker.jit.seedTransportedWarmth(workerSum, null);
    const workerSites = [...worker.jit.syncCallSitesByCaller.get(workerSum).values()].flat();
    const workerVirtual = workerSites.find((site) => site.op === 'invokevirtual');
    t.ok(workerVirtual, 'the worker registered the virtual site');
    t.equal(workerVirtual.fastDynamicTarget?.targetClassName, 'WarmthShapes$Square',
      'seeded with the requester\'s monomorphic receiver');
    const workerArea = await worker.findMethodInHierarchy('WarmthShapes$Square',
      'area', '(I)I');
    t.equal(workerVirtual.fastDynamicTarget?.target?.method, workerArea,
      'resolved against the worker\'s own classes');
    t.equal(workerVirtual.fastDynamicTarget?.positional, null,
      'with nothing runnable attached');
    t.equal(workerVirtual.transportedWarmth?.monomorphicReceiver,
      'WarmthShapes$Square', 'and the hint kept on the site');
    t.end();
  });

test('a fresh site is pre-linked on arrival from the receiver\'s own cache',
  async (t) => {
    const classpath = compileJavaFixture(t, 'WarmthShapes', VIRTUAL_FIXTURE);
    const requester = await bootFixture(classpath, SHAPE_CLASSES, JIT);
    const sum = await requester.findMethodInHierarchy('WarmthShapes', 'sum',
      '(LWarmthShapes$Shape;[II)I');
    runGenerated(requester, requester.jit.getGeneratedFunction(sum),
      'WarmthShapes', sum, [newShape('WarmthShapes$Square'), newTable(), 8]);
    const warmth = JSON.parse(JSON.stringify(
      requester.jit.describeCallSiteWarmth(sum)));

    // The receiver: never ran sum(), so it has NO site for its calls, but
    // it has bodies for the callees. This is the "no warm counterpart"
    // case that arrival-point aliasing cannot serve.
    const receiver = await bootFixture(classpath, SHAPE_CLASSES, JIT);
    const receiverSum = await receiver.findMethodInHierarchy('WarmthShapes',
      'sum', '(LWarmthShapes$Shape;[II)I');
    const area = await receiver.findMethodInHierarchy('WarmthShapes$Square',
      'area', '(I)I');
    const bias = await receiver.findMethodInHierarchy('WarmthShapes', 'bias',
      '([II)I');
    t.ok(receiver.jit.getGeneratedFunction(area) &&
      receiver.jit.getGeneratedFunction(bias), 'the callees are cached here');
    t.notOk(receiver.jit.syncCallSitesByCaller.get(receiverSum),
      'the receiver has no site of sum() at all');

    // The worker compiles under the protocol: an id grant above the
    // receiver's watermark, the result carrying its table entries.
    const worker = await bootFixture(classpath, SHAPE_CLASSES, JIT);
    const workerSum = await worker.findMethodInHierarchy('WarmthShapes', 'sum',
      '(LWarmthShapes$Shape;[II)I');
    const base = worker.jit.reserveSiteIdSpace(receiver.jit.siteIdWatermark());
    worker.jit.seedTransportedWarmth(workerSum, warmth);
    const workerGenerated = worker.jit.getGeneratedFunction(workerSum);
    worker.jit.seedTransportedWarmth(workerSum, null);
    const payload = JSON.parse(JSON.stringify(
      worker.jit.serializeGeneratedResult(workerGenerated, {
        provenance: receiver.jit.captureResultProvenance(),
        siteTablesSince: base })));
    t.ok(payload, 'the worker result serializes');
    const before = receiver.jit.prewarmedTransportedSites || 0;
    const installed = receiver.jit.materializeGeneratedResult(payload,
      receiverSum, { warmth });
    t.ok(installed, 'the receiver installs it');
    t.ok((receiver.jit.prewarmedTransportedSites || 0) > before,
      'arrival pre-linked at least one site');
    const sites = [...receiver.jit.syncCallSitesByCaller.get(receiverSum).values()].flat();
    const virtual = sites.find((site) => site.op === 'invokevirtual');
    const staticSite = sites.find((site) => site.methodName === 'bias');
    t.ok(virtual?.targets.has('WarmthShapes$Square'),
      'the virtual site holds the learned receiver type');
    t.equal(virtual?.fastDynamicTarget?.target?.method, area,
      'resolved to the receiver\'s own method');
    t.ok(virtual?.fastPositional?.invoke,
      'with a positional entry from the cached body');
    t.ok(staticSite?.fastStaticTarget && staticSite?.fastPositional?.invoke,
      'the static site is linked to the cached bias() body');

    // The proof: the first call through the installed body takes no
    // generic dispatch at all.
    const generic = receiver.jit.tryInvokeSyncAtSite;
    receiver.jit.tryInvokeSyncAtSite = () => {
      throw new Error('generic dispatch ran for a pre-linked site');
    };
    let value = null;
    let error = null;
    try {
      value = runGenerated(receiver, installed, 'WarmthShapes', receiverSum,
        [newShape('WarmthShapes$Square'), newTable(), 8]);
    } catch (thrown) {
      error = thrown;
    } finally {
      receiver.jit.tryInvokeSyncAtSite = generic;
    }
    t.error(error, 'the first call through the transported body is warm');
    t.equal(value, expectedSum((i) => i * i, 8), 'and computes the guest result');

    // A receiver type the requester never saw is not pre-linked: the site
    // learns it the ordinary way when it happens.
    t.notOk(virtual.targets.has('WarmthShapes$Wide'),
      'an unseen receiver type is left to generic dispatch');
    t.end();
  });

test('the transport still binds descriptors that carry no site id',
  async (t) => {
    const classpath = compileJavaFixture(t, 'WarmthShapes', VIRTUAL_FIXTURE);
    const jvm = await bootFixture(classpath, SHAPE_CLASSES, JIT);
    const sum = await jvm.findMethodInHierarchy('WarmthShapes', 'sum',
      '(LWarmthShapes$Shape;[II)I');
    const generated = jvm.jit.getGeneratedFunction(sum);
    const payload = JSON.parse(JSON.stringify(
      jvm.jit.serializeGeneratedResult(generated)));
    const strip = (spec) => {
      for (const d of Object.values(spec?.captures || {})) delete d.id;
    };
    for (const body of Object.values(payload.bodies || {})) strip(body);
    strip(payload.fast?.bodies?.framed);
    const rebuilt = jvm.jit.materializeGeneratedResult(payload, sum);
    t.ok(rebuilt, 'an id-less payload (older sender) still materializes');
    const value = runGenerated(jvm, rebuilt, 'WarmthShapes', sum,
      [newShape('WarmthShapes$Wide'), newTable(), 5]);
    t.equal(value, expectedSum((i) => i * 2, 5), 'and runs correctly');
    t.end();
  });

// The real thing: a worker_threads worker, the request carrying warmth over
// postMessage, the arriving body pre-linked on the main thread.
const WORKER_FIXTURE = `
public class WarmthWorkerProbe {
  static abstract class Shape { abstract int area(int k); }
  static final class Square extends Shape { int area(int k) { return k * k; } }
  static int bias(int[] table, int k) {
    table[k & 3] += 1;
    return table[k & 3] + k;
  }
  static int sum(Shape shape, int[] table, int n) {
    int acc = 0;
    for (int i = 0; i < n; i++) acc += shape.area(i) + bias(table, i);
    return acc;
  }
  public static void main(String[] args) {
    Shape shape = new Square();
    int[] table = new int[4];
    int acc = 0;
    for (int round = 0; round < 400; round++) acc += sum(shape, table, 16);
    System.out.println(acc);
  }
}
`;

test('a worker thread receives the learned link state and the main thread ' +
  'installs pre-linked bodies', async (t) => {
  const classpath = compileJavaFixture(t, 'WarmthWorkerProbe', WORKER_FIXTURE);
  // Preparation compiles on the calling thread; the worker serves what is
  // compiled after main(), which is where a site has had a chance to learn.
  // The structured tier, whose bodies read the site's link in their own
  // text: that is what makes "no generic dispatch" observable below.
  const jvm = new JVM({ classpath, prepareBeforeMain: false,
    jit: { ...JIT, compileWorker: true } });
  t.teardown(() => jvm.jit.compileWorker.dispose());
  let printed = '';
  jvm.registerJreMethods({ 'java/io/PrintStream': {
    'println(I)V': (_j, _o, args) => { printed += `${args[0]}\n`; } } });
  const describe = jvm.jit.describeCallSiteWarmth.bind(jvm.jit);
  const carried = [];
  jvm.jit.describeCallSiteWarmth = (method) => {
    const warmth = describe(method);
    if (warmth) carried.push({ method: method.name, warmth });
    return warmth;
  };
  await jvm.run('WarmthWorkerProbe');
  await jvm.jit.compileWorker.whenIdle();
  const stats = jvm.jit.compileWorker.stats;
  t.ok(stats.installed > 0, `the worker installed bodies (${JSON.stringify(stats)})`);
  // A method's sites exist only once it has a compiled body, so its FIRST
  // request cannot carry anything: nothing has been learned yet. Warmth is
  // for the recompile -- an upgrade or replacement of a body whose sites
  // have been running -- which is exactly the case that used to lose it.
  t.equal(carried.length, 0,
    'first-time requests carry no link state, there is none to carry');
  const sum = await jvm.findMethodInHierarchy('WarmthWorkerProbe', 'sum',
    '(LWarmthWorkerProbe$Shape;[II)I');
  const before = jvm.jit.codegenCache.get(sum);
  t.ok(before && jvm.jit.compileWorker.installedMethods.has(sum),
    'sum() has a worker-built body after the run');
  // The probe finishes in the interpreter before the worker's body lands,
  // so run the installed body itself: this is what warms its sites.
  t.equal(runGenerated(jvm, before, 'WarmthWorkerProbe', sum,
    [newShape('WarmthWorkerProbe$Square'), newTable(), 8]),
  expectedSum((i) => i * i, 8), 'the installed body computes the guest result');
  const learned = jvm.jit.describeCallSiteWarmth(sum);
  t.ok(learned && learned.some((entry) => entry.op === 'invokevirtual' &&
    entry.monomorphicReceiver === 'WarmthWorkerProbe$Square'),
  'its virtual site learned the Square receiver by running');
  const installedBefore = stats.installed;

  // The replacement round: the same conversation over postMessage, for a
  // method whose sites are warm. The arriving table entries are recorded so
  // the assertion below can name the exact records the new body uses.
  const client = jvm.jit.compileWorker;
  const receive = client.receive.bind(client);
  let arrived = null;
  client.receive = (message) => {
    if (message?.type === 'result' && message.payload?.siteTables) {
      arrived = message.payload.siteTables.syncCallSites.map((e) => e.index);
    }
    return receive(message);
  };
  t.ok(client.enqueue(sum, { replacementOf: before }),
    'the worker takes the replacement request');
  await client.whenIdle();
  t.equal(stats.installed, installedBefore + 1, 'and installs the replacement');
  const sumWarmth = carried.find((c) => c.method === 'sum');
  t.ok(sumWarmth, 'the replacement request carried the learned link state');
  t.ok(sumWarmth && sumWarmth.warmth.some((entry) =>
    entry.op === 'invokevirtual' &&
    entry.monomorphicReceiver === 'WarmthWorkerProbe$Square'),
  'including the receiver type its virtual site had learned');
  const after = jvm.jit.codegenCache.get(sum);
  t.notEqual(after, before, 'the transported replacement is the published body');
  t.ok(Array.isArray(arrived) && arrived.length >= 2,
    `the replacement carried its call-site entries (${JSON.stringify(arrived)})`);
  const records = (arrived || []).map((index) => jvm.jit.syncCallSites[index]);
  const virtualRecord = records.find((r) => r?.op === 'invokevirtual');
  t.equal(virtualRecord?.fastDynamicTarget?.targetClassName,
    'WarmthWorkerProbe$Square',
    'its virtual site is the WARM record the previous body ran through');
  t.ok(records.find((r) => r?.op === 'invokestatic')?.fastPositional,
    'and so is its static site');

  const generic = jvm.jit.tryInvokeSyncAtSite;
  jvm.jit.tryInvokeSyncAtSite = () => {
    throw new Error('generic dispatch ran through the transported replacement');
  };
  let value = null;
  let error = null;
  try {
    value = runGenerated(jvm, after, 'WarmthWorkerProbe', sum,
      [newShape('WarmthWorkerProbe$Square'), newTable(), 8]);
  } catch (thrown) {
    error = thrown;
  } finally {
    jvm.jit.tryInvokeSyncAtSite = generic;
  }
  t.error(error, 'the first call through the replacement is warm');
  t.equal(value, expectedSum((i) => i * i, 8), 'and computes the guest result');
  const expected = (() => {
    const table = [0, 0, 0, 0];
    let acc = 0;
    for (let round = 0; round < 400; round++) {
      for (let i = 0; i < 16; i++) {
        table[i & 3] += 1;
        acc += i * i + table[i & 3] + i;
      }
    }
    return acc;
  })();
  t.equal(printed, `${expected}\n`, 'the program printed the guest result');
  t.end();
});

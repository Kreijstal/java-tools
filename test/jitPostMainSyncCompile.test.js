// Phase 1 observability (docs/phase1-worker-audit.md, tasks 1 and 4):
// synchronous compilation is split into pre-main and post-main accounting,
// with a diagnostic trace mode and an opt-in assertion that fails any
// optimization-related synchronous compile after main().
//
// The accounting contract (from the review):
// - the aggregate stall-time counter counts only the OUTERMOST compile
//   interval, so nested compiles do not double-count the overlap;
// - every attempt (success, null result, thrown exception) is counted;
// - the assertion is checked BEFORE compiler work and never masks the
//   original compiler error.
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

function simpleMethod() {
  return {
    className: 'X', name: 'm', descriptor: '()V', flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: ['return'].map((instruction, index) =>
        ({ labelDef: `L${index}:`, instruction })),
      localsSize: '0', stackSize: '0', exceptionTable: [],
    } }],
  };
}

test('preparation compiles before main(); the counters say so', async (t) => {
  const classpath = compileProbe(t, 'jit-postmain-pre-');
  const jvm = new JVM({ classpath,
    jit: { profileMethods: true, compileWorker: false } });
  t.teardown(() => jvm.jit.compileWorker.dispose());
  await jvm.run('HotnessProbe');

  const census = jvm.jit.syncCompileCensus();
  t.equal(census.mainStarted, true, 'main() was marked as started');
  t.ok(census.preMainSyncCompileCount > 0,
    `preparation compiled ${census.preMainSyncCompileCount} methods pre-main`);
  t.ok(census.preMainSyncCompileMs >= 0, 'pre-main ms recorded');
  t.equal(census.postMainSyncCompileCount, 0,
    'nothing compiled synchronously after main() with preparation on');
  t.end();
});

test('without preparation, synchronous compiles land after main()',
  async (t) => {
  const classpath = compileProbe(t, 'jit-postmain-after-');
  const jvm = new JVM({ classpath, prepareBeforeMain: false,
    jit: { profileMethods: true, compileWorker: false } });
  t.teardown(() => jvm.jit.compileWorker.dispose());
  await jvm.run('HotnessProbe');

  const census = jvm.jit.syncCompileCensus();
  t.equal(census.preMainSyncCompileCount, 0,
    'no preparation work pre-main');
  t.ok(census.postMainSyncCompileCount > 0,
    `the running guest compiled ${census.postMainSyncCompileCount} methods ` +
    'synchronously');
  t.ok(census.postMainSyncCompileMs > 0, 'post-main ms recorded');
  t.ok(Object.keys(census.postMainSyncCompileByTier).length > 0,
    'the per-tier census names which tier stalled');
  t.end();
});

test('the compile worker keeps post-main synchronous compiles at zero',
  async (t) => {
  const classpath = compileProbe(t, 'jit-postmain-worker-');
  const jvm = new JVM({ classpath, prepareBeforeMain: false,
    jit: { profileMethods: true, compileWorker: true } });
  t.teardown(() => jvm.jit.compileWorker.dispose());
  await jvm.run('HotnessProbe');
  await jvm.jit.compileWorker.whenIdle();

  t.equal(jvm.jit.syncCompileCensus().postMainSyncCompileCount, 0,
    'the worker took every post-main compile off the main thread');
  t.ok(jvm.jit.compileWorker.stats.installed > 0,
    'and those bodies were actually installed');
  t.end();
});

test('the aggregate stall time counts only the outermost interval',
  (t) => {
  const jvm = new JVM({ jit: { compileWorker: false } });
  t.teardown(() => jvm.jit.compileWorker.dispose());
  const jit = jvm.jit;
  let now = 0;
  jit.monotonicNow = () => now;
  jit.markMainStarted();

  const method = simpleMethod();
  const callee = { className: 'X', name: 'callee', descriptor: '()V' };
  // Outer compile: 2 ms own work, 6 ms nested compile, 2 ms own work.
  const outer = jit.startSynchronousCompile(method, 'compileMethod');
  now = 2;
  const inner = jit.startSynchronousCompile(callee, 'compileMethod');
  now = 8;
  inner.finish('nested-tier');
  now = 10;
  outer.finish('outer-tier');

  t.equal(jit.postMainSyncCompileCount, 2,
    'both compile attempts are counted individually');
  t.equal(jit.postMainSyncCompileMs, 10,
    'aggregate elapsed time counts the outermost interval once (10, not 16)');
  t.deepEqual(jit.postMainSyncCompileByTier.get('outer-tier'),
    { count: 1, inclusiveMs: 10 }, 'outer tier records its inclusive time');
  t.deepEqual(jit.postMainSyncCompileByTier.get('nested-tier'),
    { count: 1, inclusiveMs: 6 }, 'nested tier records its inclusive time');
  t.equal(jit.syncCompileDepth, 0, 'nesting depth returns to zero');
  t.end();
});

test('each entry point counts success, null, and thrown attempts', (t) => {
  const jvm = new JVM({ jit: { compileWorker: false, hotCallGraphRegions: true } });
  t.teardown(() => jvm.jit.compileWorker.dispose());
  const jit = jvm.jit;
  jit.markMainStarted();
  jit.graphOwnedStructuredCandidatesEnabled = true;
  jit.structuredSsa.enabled = true;

  const count = () => jit.postMainSyncCompileCount;

  // compileMethod — success
  jit._compileMethodUntimed = () => ({ jvmStructuredSsa: true });
  t.ok(jit.compileMethod(simpleMethod())?.jvmStructuredSsa,
    'compileMethod succeeds');
  const afterSuccess = count();
  t.equal(afterSuccess, 1, 'success counted');

  // compileMethod — null result
  jit._compileMethodUntimed = () => null;
  t.equal(jit.compileMethod(simpleMethod()), null, 'compileMethod returns null');
  t.equal(count(), afterSuccess + 1, 'null counted');

  // compileMethod — thrown exception (identity preserved)
  const boom = new Error('boom');
  jit._compileMethodUntimed = () => { throw boom; };
  let threw = null;
  try { jit.compileMethod(simpleMethod()); } catch (error) { threw = error; }
  t.equal(threw, boom, 'original compiler exception identity is preserved');
  t.equal(count(), afterSuccess + 2, 'throw counted');

  // getStructuredRegionCandidate — success / null / throw. A fresh method per
  // case avoids the regionStructuredCandidates cache masking the result.
  const canonical = { jvmSynchronous: true };
  jit.structuredSsa.compile = () => ({ jvmStructuredSsa: true });
  t.ok(jit.getStructuredRegionCandidate(simpleMethod(), canonical)
    ?.jvmStructuredSsa, 'region candidate succeeds');
  const afterRegionSuccess = count();
  t.equal(afterRegionSuccess, afterSuccess + 3, 'region success counted');

  jit.structuredSsa.compile = () => null;
  t.equal(jit.getStructuredRegionCandidate(simpleMethod(), canonical), null,
    'region candidate returns null');
  t.equal(count(), afterRegionSuccess + 1, 'region null counted');

  const regionBoom = new Error('region boom');
  jit.structuredSsa.compile = () => { throw regionBoom; };
  const regionMethod = simpleMethod();
  // getStructuredRegionCandidate swallows ordinary compile errors and returns
  // null; that is its pre-existing behavior and must stay unchanged. The
  // attempt is still finalized in the finally block.
  t.equal(jit.getStructuredRegionCandidate(regionMethod, canonical), null,
    'region compile error is swallowed and returns null (unchanged behavior)');
  t.equal(jit.codegenCompileErrors.get(regionMethod), regionBoom,
    'the original error is still recorded in codegenCompileErrors');
  t.equal(count(), afterRegionSuccess + 2, 'region throw counted');

  // compileHotCallGraphRegion — success / null / throw.
  const graphCompile = jit.hotCallGraphRegions.compile;
  jit.hotCallGraphRegions.compile = () => ({ jvmHotCallGraphFramedSource: true });
  t.ok(jit.compileHotCallGraphRegion(simpleMethod())
    ?.jvmHotCallGraphFramedSource, 'hot call graph succeeds');
  const afterGraphSuccess = count();
  t.equal(afterGraphSuccess, afterRegionSuccess + 3, 'graph success counted');

  jit.hotCallGraphRegions.compile = () => null;
  t.equal(jit.compileHotCallGraphRegion(simpleMethod()), null,
    'hot call graph returns null');
  t.equal(count(), afterGraphSuccess + 1, 'graph null counted');

  const graphBoom = new Error('graph boom');
  jit.hotCallGraphRegions.compile = () => { throw graphBoom; };
  threw = null;
  try { jit.compileHotCallGraphRegion(simpleMethod()); }
  catch (error) { threw = error; }
  t.equal(threw, graphBoom, 'graph exception identity preserved');
  t.equal(count(), afterGraphSuccess + 2, 'graph throw counted');
  jit.hotCallGraphRegions.compile = graphCompile;
  t.end();
});

test('the assertion is checked before compiler work', (t) => {
  const previous = process.env.JVM_JIT_ASSERT_NO_POST_MAIN_SYNC_COMPILE;
  process.env.JVM_JIT_ASSERT_NO_POST_MAIN_SYNC_COMPILE = '1';
  t.teardown(() => {
    if (previous === undefined) {
      delete process.env.JVM_JIT_ASSERT_NO_POST_MAIN_SYNC_COMPILE;
    } else {
      process.env.JVM_JIT_ASSERT_NO_POST_MAIN_SYNC_COMPILE = previous;
    }
  });
  const jvm = new JVM({ jit: { compileWorker: false } });
  t.teardown(() => jvm.jit.compileWorker.dispose());
  const jit = jvm.jit;
  jit.markMainStarted();
  let entered = false;
  jit._compileMethodUntimed = () => { entered = true; return null; };

  let threw = null;
  try { jit.compileMethod(simpleMethod()); } catch (error) { threw = error; }
  t.ok(threw && threw.jitAssertNoPostMainSyncCompile, 'the assertion throws');
  t.equal(entered, false, 'the compiler never ran');
  t.equal(jit.postMainSyncCompileCount, 0,
    'no attempt was recorded because nothing entered the compiler');
  t.end();
});

test('the diagnostic trace identifies the entry path', (t) => {
  const previous = process.env.JVM_JIT_TRACE_POST_MAIN_SYNC_COMPILE;
  process.env.JVM_JIT_TRACE_POST_MAIN_SYNC_COMPILE = '1';
  t.teardown(() => {
    if (previous === undefined) {
      delete process.env.JVM_JIT_TRACE_POST_MAIN_SYNC_COMPILE;
    } else {
      process.env.JVM_JIT_TRACE_POST_MAIN_SYNC_COMPILE = previous;
    }
  });
  const lines = [];
  const originalError = console.error;
  console.error = (line) => lines.push(String(line));
  t.teardown(() => { console.error = originalError; });

  const jvm = new JVM({ jit: { compileWorker: false } });
  t.teardown(() => jvm.jit.compileWorker.dispose());
  const jit = jvm.jit;
  jit.markMainStarted();
  jit._compileMethodUntimed = () => ({ jvmSynchronous: true });
  jit.compileMethod(simpleMethod());
  console.error = originalError;

  const trace = lines.find((line) => line.startsWith('[jit-post-main-sync-compile]'));
  t.ok(trace, 'a trace line was emitted');
  t.ok(trace.includes('"entryPath":"compileMethod"'),
    `the trace names the entry path (${trace})`);
  t.end();
});

test('the assertion is off by default and pre-main compiles never trip it',
  async (t) => {
  const classpath = compileProbe(t, 'jit-postmain-default-');
  const jvm = new JVM({ classpath,
    jit: { profileMethods: true, compileWorker: false } });
  t.teardown(() => jvm.jit.compileWorker.dispose());
  await jvm.run('HotnessProbe');
  t.equal(jvm.jit.syncCompileCensus().postMainSyncCompileCount, 0,
    'preparation compiled everything before the assertion boundary');
  t.end();
});

test('JVM_JIT_ASSERT_NO_POST_MAIN_SYNC_COMPILE fails a post-main compile',
  async (t) => {
  const classpath = compileProbe(t, 'jit-postmain-assert-');
  const previous = process.env.JVM_JIT_ASSERT_NO_POST_MAIN_SYNC_COMPILE;
  process.env.JVM_JIT_ASSERT_NO_POST_MAIN_SYNC_COMPILE = '1';
  t.teardown(() => {
    if (previous === undefined) {
      delete process.env.JVM_JIT_ASSERT_NO_POST_MAIN_SYNC_COMPILE;
    } else {
      process.env.JVM_JIT_ASSERT_NO_POST_MAIN_SYNC_COMPILE = previous;
    }
  });

  const jvm = new JVM({ classpath, prepareBeforeMain: false,
    jit: { profileMethods: true, compileWorker: false } });
  t.teardown(() => jvm.jit.compileWorker.dispose());
  const err = await jvm.run('HotnessProbe').then(
    () => null, (e) => e);
  t.ok(err, 'the run threw');
  t.ok(err && err.jitAssertNoPostMainSyncCompile,
    'the error is the post-main assertion, not something else');
  t.ok(/HotnessProbe\.main/.test(err ? err.message : ''),
    'the assertion names the method');
  t.ok(/entryPath=/.test(err ? err.message : ''),
    'the assertion names the entry path');
  t.end();
});

// Section 0.2: "A refused, stale, or failed compile leaves the current
// executable tier intact. It does NOT authorize synchronous compilation on the
// main thread." A worker that will not take a method is the case that used to
// fall straight through to the local compiler, which is a post-main stall the
// contract forbids -- so after main() the method keeps its current tier and
// the refusal is counted instead.
function ghostMethod(jvm, className) {
  const method = {
    className, name: 'add', descriptor: '(II)I', flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: ['iload_0', 'iload_1', 'iadd', 'ireturn']
        .map((instruction, index) => ({ labelDef: `L${index}:`, instruction })),
      localsSize: '2', stackSize: '2', exceptionTable: [],
    } }],
  };
  jvm.classes[className] = {
    staticFields: new Map(),
    ast: { classes: [{ className, superClassName: 'java/lang/Object',
      items: [{ type: 'method', method }] }] },
  };
  jvm.classInitializationState.set(className, 'INITIALIZED');
  // Absent from the worker's classpath and unsendable as class data, so the
  // worker can obtain it by neither route and refuses it deterministically.
  jvm.jit.compileWorker.unsendableClasses.add(className);
  return method;
}

test('after main(), a method the worker will not take keeps its tier',
  async (t) => {
  const classpath = compileProbe(t, 'jit-postmain-refused-');
  const jvm = new JVM({ classpath, prepareBeforeMain: false,
    jit: { profileMethods: true, compileWorker: true, warmupThreshold: 0 } });
  t.teardown(() => jvm.jit.compileWorker.dispose());
  await jvm.loadClassByName('HotnessProbe');
  const client = jvm.jit.compileWorker;
  const method = ghostMethod(jvm, 'PostMainGhostProbe');

  t.ok(client.enqueue(method, {}), 'the method is offered to the worker');
  await client.whenIdle();
  t.ok(client.declined.has(method), 'the worker retired it');

  jvm.guestStarted = true;
  jvm.jit.markMainStarted();
  const before = jvm.jit.syncCompileCensus();
  t.equal(jvm.jit.getGeneratedFunction(method), null,
    'no body is built on the guest thread');
  const after = jvm.jit.syncCompileCensus();
  t.equal(after.postMainSyncCompileCount, before.postMainSyncCompileCount,
    'and no synchronous post-main compile was entered');
  t.equal(after.workerUnservedPostMainCount,
    before.workerUnservedPostMainCount + 1,
    'the method the queue would not serve is counted, not silently dropped');
  t.end();
});

test('legacy control: a send that never reached a worker still compiles here',
  async (t) => {
  // Preserve the old behavior as an explicit A/B control, not the desired
  // no-stall contract. backgroundCodegenRequests.test.js checks the new policy.
  const classpath = compileProbe(t, 'jit-postmain-nosend-');
  const jvm = new JVM({ classpath, prepareBeforeMain: false,
    jit: { profileMethods: true, compileWorker: true, warmupThreshold: 0,
      backgroundCodegen: false } });
  t.teardown(() => jvm.jit.compileWorker.dispose());
  await jvm.loadClassByName('HotnessProbe');
  const client = jvm.jit.compileWorker;
  client.ensureWorker = () => ({ postMessage() {
    throw new Error('no worker on this host'); }, ref() {}, unref() {} });

  const method = jvm.classes['HotnessProbe'].ast.classes[0].items
    .find((item) => item?.type === 'method')?.method;
  t.ok(method, 'the probe has a method to ask for');
  jvm.guestStarted = true;
  jvm.jit.markMainStarted();

  t.equal(jvm.jit.getGeneratedFunction(method), null,
    'the first ask queues it, so nothing is built yet');
  t.ok(client.stats.failed > 0, 'the send failed');
  t.ok(client.declined.has(method), 'and the method was declined');
  t.notOk(client.declinedByRefusal.has(method),
    'but not as a refusal: no worker ever considered it');
  t.ok(jvm.jit.getGeneratedFunction(method),
    'so asking again compiles it here rather than stranding it');
  t.end();
});

// Phase 1 worker observability (docs/phase1-worker-audit.md, tasks 2 and 3):
// the cost of installing a worker result is broken out per phase, and the
// worker census reports completed/superseded plus aggregated refusal and
// staleness reasons instead of free-form strings.
const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JVM } = require('../src/core/jvm');
const frontend = require('../src/java-frontend');
const { CompileWorkerClient } = require('../src/jit/CompileWorkerClient');

function compileProbe(t, prefix) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.teardown(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  frontend.compileJavaFile(
    path.resolve(__dirname, '../sources/HotnessProbe.java'),
    { outputDir, sourceFileName: 'HotnessProbe.java' });
  return outputDir;
}

test('a worker install records its phase cost on the main thread',
  async (t) => {
  const classpath = compileProbe(t, 'jit-census-install-');
  const jvm = new JVM({ classpath, prepareBeforeMain: false,
    jit: { profileMethods: true, compileWorker: true } });
  t.teardown(() => jvm.jit.compileWorker.dispose());
  await jvm.run('HotnessProbe');
  await jvm.jit.compileWorker.whenIdle();

  const install = jvm.jit.installCensus();
  t.ok(install.installCount > 0,
    `installed ${install.installCount} bodies`);
  for (const phase of ['validationMs', 'descriptorBindingMs', 'newFunctionMs',
    'wasmInstantiationMs', 'publicationMs', 'totalInstallMs']) {
    t.ok(install[phase] >= 0, `${phase} is recorded (${install[phase]})`);
  }
  t.ok(install.largestInstallMs >= 0 &&
    install.largestInstallMs <= install.totalInstallMs + 1e-9,
    'largestInstallMs is the largest single install, bounded by the total');
  t.ok(install.attemptCount >= install.installCount,
    'attempts (installed + rejected + superseded) are at least installs');
  t.ok(install.postMainAttemptCount > 0,
    'install work is attributed to the post-main window');
  t.equal(install.preMainAttemptCount, 0,
    'no install work happened before main() in this worker-driven run');
  // The JS-tier protocol carries text, not WebAssembly.Module, so there is
  // nothing to instantiate; the phase is zero by construction, not missing.
  t.equal(install.wasmInstantiationMs, 0,
    'wasm instantiation is zero for JS-tier transported bodies');
  t.end();
});

test('a rejected result records an attempt but not an install', (t) => {
  const jvm = new JVM({ jit: { compileWorker: false } });
  t.teardown(() => jvm.jit.compileWorker.dispose());
  const jit = jvm.jit;
  jit.markMainStarted();

  const before = jit.installCensus();
  jit.recordResultInstallTiming(
    { validationMs: 1, descriptorBindingMs: 0, newFunctionMs: 0,
      wasmInstantiationMs: 0, publicationMs: 0, totalInstallMs: 3 },
    { installed: false });
  const after = jit.installCensus();
  t.equal(after.attemptCount, before.attemptCount + 1, 'attempt counted');
  t.equal(after.installCount, before.installCount,
    'a rejected result does not count as an install');
  t.equal(after.postMainAttemptMs, before.postMainAttemptMs + 3,
    'the rejected attempt time is still main-thread work');
  t.end();
});

test('the census counts completed and superseded results', async (t) => {
  const classpath = compileProbe(t, 'jit-census-counts-');
  const jvm = new JVM({ classpath, prepareBeforeMain: false,
    jit: { profileMethods: true, compileWorker: true } });
  t.teardown(() => jvm.jit.compileWorker.dispose());
  await jvm.run('HotnessProbe');
  await jvm.jit.compileWorker.whenIdle();

  const stats = jvm.jit.compileWorker.stats;
  t.equal(stats.completed,
    stats.installed + stats.refused + stats.stale + stats.superseded,
    'completed accounts for every received result');
  t.ok(stats.superseded >= 0, 'superseded is recorded');
  t.end();
});

test('refusal and staleness reasons are aggregated into stable keys',
  (t) => {
  // Reuse the classifier directly so every known worker refusal string maps
  // to the short key the census reports, not a parsed log line.
  const client = new CompileWorkerClient(
    { jvm: {}, constructor: { transportableSiteTables: [] } },
    { compileWorker: false });
  t.equal(client.classifyRefusalReason('method not mirrored in the worker'),
    'method-not-mirrored');
  t.equal(client.classifyRefusalReason(
    'uses untransportable tables [inlineLoopRegions]'),
    'untransportable-table');
  t.equal(client.classifyRefusalReason('outgrew its syncCallSites id grant'),
    'grant-overflow');
  t.equal(client.classifyRefusalReason('result is not serializable'),
    'not-serializable');
  t.equal(client.classifyStaleReason('class epoch moved 311 -> 312'),
    'class-epoch-moved');
  t.equal(client.classifyStaleReason(
    'class Foo is not initialized on this thread'),
    'initialization-assumption');
  t.equal(client.classifyStaleReason('result carries no provenance'),
    'no-provenance');
  t.equal(client.classifyStaleReason('call site 7 is already Other.m'),
    'site-conflict');
  t.end();
});

test('an unmirrored method is refused under a stable key', async (t) => {
  const classpath = compileProbe(t, 'jit-census-refused-');
  const jvm = new JVM({ classpath, prepareBeforeMain: false,
    jit: { profileMethods: true, compileWorker: true } });
  t.teardown(() => jvm.jit.compileWorker.dispose());
  await jvm.loadClassByName('HotnessProbe');
  const client = jvm.jit.compileWorker;
  const ghost = 'GhostCensusProbe';
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
  client.unsendableClasses.add(ghost);

  client.enqueue(method, {});
  await client.whenIdle();
  t.equal(client.stats.refusedReasons['method-not-mirrored'], 1,
    'the refusal is aggregated under method-not-mirrored');
  t.end();
});

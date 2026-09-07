// Phase 1 worker equivalence fixtures (docs/phase1-worker-audit.md, task 5):
// each Java fixture runs twice — worker off, then worker on — and the
// observable Java output/state must match. The comparison is behavioral: it
// deliberately does not assert which JIT tier either arm chose.
const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JVM } = require('../src/core/jvm');
const frontend = require('../src/java-frontend');

const FIXTURES = [
  'StaticFieldProbe',
  'InstanceFieldProbe',
  'VirtualCallProbe',
  'InterfaceCallProbe',
  'PrimitiveArrayProbe',
  'ReferenceArrayProbe',
  'ExceptionProbe',
  'ClassInitProbe',
  'RecursionProbe',
  'ConstructorProbe',
];

function compileFixture(t, name) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), `we-${name}-`));
  t.teardown(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  frontend.compileJavaFile(
    path.resolve(__dirname, `../sources/worker-equiv/${name}.java`),
    { outputDir, sourceFileName: `${name}.java` });
  return outputDir;
}

function capturePrintln(jvm) {
  let out = '';
  jvm.registerJreMethods({ 'java/io/PrintStream': {
    'println(I)V': (_j, _o, args) => { out += `${args[0]}\n`; },
  } });
  const capture = () => out;
  capture.reset = () => { out = ''; };
  return capture;
}

// True when a generated body actually ran for a method whose body this worker
// delivered and published. That is the tight proof that the guest used the
// transported code rather than a local fallback.
function transportedBodyRan(jvm, fixture) {
  const jit = jvm.jit;
  const installed = jit.compileWorker.installedMethods;
  const items = jvm.classes[fixture]?.ast?.classes?.[0]?.items || [];
  for (const item of items) {
    if (item?.type !== 'method' || !item.method) continue;
    const method = item.method;
    if (!installed.has(method)) continue;
    for (const [key, count] of jit.generatedMethodRunCounts) {
      if (count > 0 && key.endsWith(`.${method.name}${method.descriptor}`)) {
        return true;
      }
    }
  }
  return false;
}

for (const fixture of FIXTURES) {
  test(`worker equivalence: ${fixture} (worker off vs worker on)`,
    async (t) => {
    const classpath = compileFixture(t, fixture);

    const off = new JVM({ classpath, prepareBeforeMain: false,
      jit: { profileMethods: true, compileWorker: false, warmupThreshold: 0 } });
    t.teardown(() => off.jit.compileWorker.dispose());
    const offCap = capturePrintln(off);
    await off.run(fixture);
    const offOut = offCap();

    const on = new JVM({ classpath, prepareBeforeMain: false,
      jit: { profileMethods: true, compileWorker: true, warmupThreshold: 0 } });
    t.teardown(() => on.jit.compileWorker.dispose());
    const onCap = capturePrintln(on);
    await on.run(fixture);
    await on.jit.compileWorker.whenIdle();
    const firstOut = onCap();

    t.equal(firstOut, offOut,
      'the program produces the same output with the worker on and off');
    t.ok(on.jit.compileWorker.stats.requested > 0,
      `the worker was asked to compile at least one method (${
        JSON.stringify(on.jit.compileWorker.stats)}, last: ${
        on.jit.compileWorker.lastRefusal})`);
    t.ok(on.jit.compileWorker.stats.installed > 0,
      'the worker materialized and published at least one body');

    // The guest may finish before publication, so run the same program a
    // second time in the same JVM: the transported bodies are now published
    // and this pass actually executes them.
    onCap.reset();
    await on.run(fixture);
    await on.jit.compileWorker.whenIdle();
    t.ok(transportedBodyRan(on, fixture),
      'a worker-transported body was subsequently executed by the guest');
    t.end();
  });
}

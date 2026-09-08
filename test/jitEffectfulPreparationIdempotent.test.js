// Effectful ahead-of-main preparation must be idempotent. The browser launcher
// can invoke it from a before-run hook and then jvm.run() invokes it again via
// prepareBeforeMain; a second pass used to delete and recompile every body it
// had just built (getGeneratedFunction treated any structured/plain cached
// body as "warmed before preparation"). Verified on Deko Bloko: 2333 compiles
// on pass 1, then 2328 more on pass 2.
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

test('a second effectful preparation pass recompiles nothing', async (t) => {
  const classpath = compileProbe(t, 'jit-prep-idem-');
  const jvm = new JVM({ classpath, prepareBeforeMain: false,
    jit: { profileMethods: true, compileWorker: false } });
  t.teardown(() => jvm.jit.compileWorker.dispose());

  let compiles = 0;
  const orig = jvm.jit.compileMethod.bind(jvm.jit);
  jvm.jit.compileMethod = (method, options) => {
    compiles += 1;
    return orig(method, options);
  };

  await jvm.precompileInitializedClasses({
    preloadClasspath: true, initializedOnly: false, effectful: true,
  });
  const firstPass = compiles;
  t.ok(firstPass > 0, `first pass compiled ${firstPass} methods`);

  await jvm.precompileInitializedClasses({
    preloadClasspath: true, initializedOnly: false, effectful: true,
  });
  t.equal(compiles, firstPass,
    'the second identical pass recompiled nothing');
  t.end();
});

test('a warmed baseline is still upgraded once, then stays put', async (t) => {
  const classpath = compileProbe(t, 'jit-prep-warm-');
  const jvm = new JVM({ classpath, prepareBeforeMain: false,
    jit: { profileMethods: true, compileWorker: false, warmupThreshold: 0 } });
  t.teardown(() => jvm.jit.compileWorker.dispose());
  await jvm.loadClassByName('HotnessProbe');
  jvm.classInitializationState.set('HotnessProbe', 'INITIALIZED');

  // Warm one method by asking for it without effectful preparation.
  const items = jvm.classes.HotnessProbe.ast.classes[0].items;
  const spin = items.find((item) => item?.type === 'method' &&
    item.method.name === 'spin').method;
  const warm = jvm.jit.getGeneratedFunction(spin);
  t.ok(warm, 'the method compiles during warmup');

  let compiles = 0;
  const orig = jvm.jit.compileMethod.bind(jvm.jit);
  jvm.jit.compileMethod = (method, options) => {
    compiles += 1;
    return orig(method, options);
  };

  await jvm.precompileInitializedClasses({
    preloadClasspath: true, initializedOnly: false, effectful: true,
  });
  const afterFirst = compiles;
  t.ok(afterFirst > 0, 'preparation compiles the remaining methods');

  await jvm.precompileInitializedClasses({
    preloadClasspath: true, initializedOnly: false, effectful: true,
  });
  t.equal(compiles, afterFirst, 'the second pass recompiles nothing');
  t.end();
});

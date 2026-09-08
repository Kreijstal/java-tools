'use strict';
const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JVM } = require('../src/core/jvm');
const frontend = require('../src/java-frontend');

test('runtime accounting includes the first guest class initializer', async (t) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-start-'));
  t.teardown(() => fs.rmSync(outputDir, {recursive: true, force: true}));
  frontend.compileJavaFile(path.resolve(__dirname, '../sources/RuntimeStartProbe.java'),
    {outputDir, sourceFileName: 'RuntimeStartProbe.java'});
  const observations = [];
  const jvm = new JVM({classpath: outputDir, jit: {compileWorker: false},
    jreOverrides: {RuntimeStartObserver: {methods: {
      'observe()V': (runtime) => observations.push({
        guestStarted: runtime.guestStarted,
        measured: runtime.jit.mainStarted,
      }),
    }}},
  });
  const prepare = jvm.precompileInitializedClasses.bind(jvm);
  jvm.precompileInitializedClasses = async (options) => {
    const result = await prepare(options);
    t.equal(observations.length, 0, 'preparation executes no guest initializer');
    t.equal(jvm.jit.mainStarted, false, 'preparation is outside the runtime clock');
    return result;
  };
  await jvm.run('RuntimeStartProbe');
  t.deepEqual(observations, [
    {guestStarted: true, measured: true},
    {guestStarted: true, measured: true},
  ], 'both the static initializer and main execute inside the measured interval');
  t.end();
});

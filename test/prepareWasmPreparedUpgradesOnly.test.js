// The ahead-of-main preparation pass run() performs hands the Wasm tier every
// loop-bearing method unless the JVM is told to limit it to the JS-prepared
// oversized-loop upgrades -- the shape apps/launcher/browser-runtime.js asks
// for explicitly. A launcher that hosts the JVM through the debug controller
// (preparation off by default) and turns it back on needs the same limit from
// the option alone, without calling precompileInitializedClasses itself.
'use strict';
const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JVM } = require('../src/core/jvm');
const frontend = require('../src/java-frontend');

function withProbe(t) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-wasm-'));
  t.teardown(() => fs.rmSync(outputDir, {recursive: true, force: true}));
  frontend.compileJavaFile(path.resolve(__dirname, '../sources/RuntimeStartProbe.java'),
    {outputDir, sourceFileName: 'RuntimeStartProbe.java'});
  return outputDir;
}

test('run() limits the preparation pass to prepared Wasm upgrades only when asked', async (t) => {
  const outputDir = withProbe(t);
  for (const [options, expected, rest] of [
    [{}, false, {wasm: true, effectful: true, loopsOnly: false}],
    [{prepareWasmPreparedUpgradesOnly: true}, true, {wasm: true, effectful: true, loopsOnly: false}],
    [{prepareWasmPreparedUpgradesOnly: 'yes'}, false, {wasm: true, effectful: true, loopsOnly: false}],
    [{prepareWasm: false, prepareEffectful: false, prepareLoopsOnly: true}, false,
      {wasm: false, effectful: false, loopsOnly: true}],
  ]) {
    const jvm = new JVM({classpath: outputDir, jit: {compileWorker: false},
      jreOverrides: {RuntimeStartObserver: {methods: {'observe()V': () => {}}}},
      ...options});
    let seen = null;
    const prepare = jvm.precompileInitializedClasses.bind(jvm);
    jvm.precompileInitializedClasses = async (passOptions) => {
      seen = passOptions;
      return prepare(passOptions);
    };
    await jvm.run('RuntimeStartProbe');
    t.ok(seen, `${JSON.stringify(options)}: run() prepared before main`);
    t.equal(seen.wasmPreparedUpgradesOnly, expected,
      `${JSON.stringify(options)}: wasmPreparedUpgradesOnly is ${expected}`);
    t.deepEqual({wasm: seen.wasm, effectful: seen.effectful, loopsOnly: seen.loopsOnly}, rest,
      `${JSON.stringify(options)}: the pass's halves follow the options`);
  }
  t.end();
});

test('a JVM hosted with preparation off can ask for it explicitly', async (t) => {
  const outputDir = withProbe(t);
  const DebugController = require('../src/debug/debugController');
  const controller = new DebugController({classpath: outputDir,
    jit: {compileWorker: false},
    jreOverrides: {RuntimeStartObserver: {methods: {'observe()V': () => {}}}},
    prepareBeforeMain: true, prepareWasmPreparedUpgradesOnly: true});
  t.equal(controller.jvm.prepareBeforeMain, true, 'the caller\'s request wins over the controller default');
  t.equal(controller.jvm.prepareWasmPreparedUpgradesOnly, true, 'and the Wasm limit travels with it');
  const plain = new DebugController({classpath: outputDir});
  t.equal(plain.jvm.prepareBeforeMain, false, 'the controller default is still off');
  t.end();
});

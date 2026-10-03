'use strict';
const test = require('tape');
const {JVM} = require('../src/core/jvm');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const fixture = makeJavaFixtureCompiler('wasm-switch-coverage-');

for (const [name, keys] of [['dense', [0, 1, 2]], ['sparse', [-100, 17, 9000]]]) {
  test(`Wasm coverage follows every ${name} switch arm`, async t => {
    const classpath = fixture(t, 'SwitchCoverage', `public class SwitchCoverage {
      public static String choose(int key) {
        if (key == 42) return null;
        switch (key) {
          case ${keys[0]}: if (key > 0) return "zero"; return "negative-zero";
          case ${keys[1]}: if (key > 0) return "one"; return "negative-one";
          case ${keys[2]}: if (key > 0) return "two"; return "negative-two";
          default: if (key > 0) return "other"; return "negative-other";
        }
      }
    }`);
    const jvm = new JVM({classpath, jit: {compileWorker: false, wasmStructured: true}});
    await jvm.preloadClasspathClasses();
    jvm.classInitializationState.set('SwitchCoverage', 'INITIALIZED');
    const method = await jvm.findMethodInHierarchy('SwitchCoverage', 'choose', '(I)Ljava/lang/String;');
    const wasm = jvm.jit.wasmJit;
    const state = wasm.methodState({method});
    wasm.compile({method, className: 'SwitchCoverage'}, state, {asCallee: true});
    const coverage = state.wasmCandidateCoverage;
    t.ok(coverage?.dispatcher, 'dispatcher coverage was produced');
    // Every arm contains an unsupported string constant. None is dead merely
    // because another arm appears first in bytecode order.
    t.equal(coverage?.dispatcher?.uncoveredItems, 18,
      'coverage includes the selector/switch and both string returns in all four arms');
    t.end();
  });
}

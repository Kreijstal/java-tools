'use strict';
const test = require('tape');
const {JVM} = require('../src/core/jvm');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const fixture = makeJavaFixtureCompiler('wasm-switch-coverage-');

for (const [name, keys] of [['dense', [0, 1, 2]], ['sparse', [-100, 17, 9000]]]) {
  test(`Wasm coverage follows every ${name} switch arm`, async t => {
    // Every arm returns through blocks containing drem, which the dispatcher
    // tier does not lower (string constants used to play this role, but the
    // dispatcher now lowers ldc String through an import, which left the arms
    // fully covered and the assertion below unable to see a missed arm).
    const classpath = fixture(t, 'SwitchCoverage', `public class SwitchCoverage {
      public static double choose(int key) {
        if (key == 42) return 0;
        switch (key) {
          case ${keys[0]}: if (key > 0) return key % 3.0; return key % 5.0;
          case ${keys[1]}: if (key > 0) return key % 3.0; return key % 5.0;
          case ${keys[2]}: if (key > 0) return key % 3.0; return key % 5.0;
          default: if (key > 0) return key % 3.0; return key % 5.0;
        }
      }
    }`);
    const jvm = new JVM({classpath, jit: {compileWorker: false, wasmStructured: true}});
    await jvm.preloadClasspathClasses();
    jvm.classInitializationState.set('SwitchCoverage', 'INITIALIZED');
    const method = await jvm.findMethodInHierarchy('SwitchCoverage', 'choose', '(I)D');
    const wasm = jvm.jit.wasmJit;
    const state = wasm.methodState({method});
    wasm.compile({method, className: 'SwitchCoverage'}, state, {asCallee: true});
    const coverage = state.wasmCandidateCoverage;
    t.ok(coverage?.dispatcher, 'dispatcher coverage was produced');
    // Every arm contains an unsupported drem. None is dead merely because
    // another arm appears first in bytecode order: the selector/switch block
    // (iload, switch = 2) plus, in each of the four arms, both return blocks
    // (iload, i2d, ldc2_w, drem, dreturn = 5 each): 2 + 4 * 2 * 5 = 42.
    t.deepEqual(coverage?.dispatcher?.demoteReasons?.map(([, reason]) => reason).sort(),
      [...Array(8).fill('drem'), name === 'dense' ? 'tableswitch' : 'lookupswitch'].sort(),
      'the switch and all eight remainder returns are demoted');
    t.equal(coverage?.dispatcher?.uncoveredItems, 42,
      'coverage includes the selector/switch and both remainder returns in all four arms');
    t.end();
  });
}

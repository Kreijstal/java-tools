'use strict';
const test = require('tape');
const { makeJavaFixtureCompiler } = require('./javaFixture');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');
const compileFixture = makeJavaFixtureCompiler('switch-partition-');

test('structured partitioning keeps switch labels in their owning dispatcher', async t => {
  const operations = (offset, length = 2) => Array.from({ length }, (_, i) =>
    `s = (s * 31) ^ ${i + offset};`).join('\n');
  const classpath = compileFixture(t, 'SwitchPartition', `
public class SwitchPartition {
  public static int run(int mode, int n, int s) {
    for (int i = 0; i < n; i++) {
      switch (mode) {
        ${Array.from({ length: 60 }, (_, mode) => `case ${mode}: ${operations(mode * 100, mode === 0 ? 100 : 2)} break;`).join('\n')}
        default: ${operations(10000)} break;
      }
    }
    return s;
  }
}`);
  const jvm = new JVM({ classpath, jit: { compileWorker: false, structuredSsa: true,
    ordinaryAdaptiveFramelessPositional: true, structuredLinearPartition: true,
    structuredLinearPartitionUnitBytes: 16384, structuredLinearPartitionSegmentBytes: 4096,
    structuredLinearPartitionMinimumSegmentBytes: 1024 } });
  await jvm.loadClassByName('SwitchPartition');
  jvm.classInitializationState.set('SwitchPartition', 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy('SwitchPartition', 'run', '(III)I');
  const body = jvm.jit.structuredSsa.compile(method);
  t.ok(body, `partitioned method compiles: ${jvm.jit.structuredSsa.lastRejectionReason}`);
  if (!body) { t.end(); return; }
  t.ok(body.jvmStructuredPartitionedSegmentCount > 0, 'actually extracts segments');
  const rebound = jvm.jit.materializeGeneratedResult(jvm.jit.serializeGeneratedResult(body), method);
  t.ok(rebound, 'partitioned method survives transport');
  for (const entry of [body, rebound]) {
    for (const mode of [0, 1, 39, 99]) for (const n of [0, 1, 3]) {
      let expected = 17;
      for (let i = 0; i < n; i++) for (let k = 0; k < (mode === 0 ? 100 : 2); k++) {
        expected = (Math.imul(expected, 31) ^ (k + (mode < 60 ? mode * 100 : 10000))) | 0;
      }
      const frame = new Frame(method); frame.className = 'SwitchPartition';
      frame.locals.splice(0, 3, mode, n, 17);
      const thread = { status: 'runnable', callStack: new Stack() }; thread.callStack.push(frame);
      jvm._nextEventLoopYieldAt = Infinity;
      const outcome = entry(frame, thread, jvm.jit, false);
      t.equal(outcome.value, expected, `mode ${mode}, ${n} iterations`);
      t.equal(thread.callStack.size(), 0, 'return retires the frame');
    }
  }
  t.end();
});

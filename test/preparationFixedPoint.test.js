// Ahead-of-main preparation runs to a fixed point: it repeats compile rounds
// while a round prepares something new, revisits a method whose dependency
// only became available after an earlier round, links every prepared call
// site, and terminates on "no progress" rather than on a round count.
'use strict';
const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JVM } = require('../src/core/jvm');
const frontend = require('../src/java-frontend');

function compileFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-fixed-'));
  t.teardown(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.writeFileSync(path.join(dir, 'Helper.java'), [
    'public class Helper {',
    '  int v;',
    '  Helper(int x) { v = x * 2 + 1; }', // a linear field initializer: a constructor the JIT admits
    '  static int compute(int x) { return x * 2 + 1; }',
    '  int value() { return v; }',
    '}',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'Callee.java'), [
    'public class Callee {',
    '  static int work(int i) { Helper h = new Helper(i); return h.value(); }',
    '  static int leaf(int i) { return i & 7; }',
    '}',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'Caller.java'), [
    'public class Caller {',
    '  static int result;',
    '  static int loop(int n) {',
    '    int s = 0;',
    '    for (int i = 0; i < n; i++) { s += Callee.work(i); s += Callee.leaf(i); }',
    '    return s;',
    '  }',
    '  public static void main(String[] args) { result = loop(200); }',
    '}',
  ].join('\n'));
  for (const name of ['Helper', 'Callee', 'Caller']) {
    frontend.compileJavaFile(path.join(dir, `${name}.java`),
      {outputDir: dir, sourceFileName: `${name}.java`});
  }
  return dir;
}

function expected(n) {
  let s = 0;
  for (let i = 0; i < n; i++) s += (i * 2 + 1) + (i & 7);
  return s;
}

function findMethod(jvm, className, name, descriptor) {
  return jvm.classes[className].ast.classes[0].items
    .find((item) => item.type === 'method' && item.method.name === name &&
      item.method.descriptor === descriptor).method;
}

test('preparation reaches a fixed point, links the prepared sites, and reports it', async (t) => {
  const dir = compileFixture(t);
  const jvm = new JVM({classpath: dir, jit: {compileWorker: false, asyncCallCensus: true}});
  await jvm.run('Caller');
  const report = jvm.preparationReport;
  t.ok(report, 'run() left a preparation report');
  t.ok(report.rounds >= 1 && report.rounds <= 8, `rounds bounded (${report.rounds})`);
  t.ok(report.newBodies > 0, `bodies were prepared (${report.newBodies})`);
  t.ok(report.linkedSites > 0, `prepared call sites were linked ahead of main (${report.linkedSites})`);
  t.equal(jvm.classes.Caller.staticFields.get('result:I'), expected(200), 'correct result');
  // Once prepared, another pass is a no-op that terminates in one round.
  const again = await jvm.precompileInitializedClasses({initializedOnly: false, effectful: true});
  t.equal(again.report.newBodies, 0, 'a second pass prepares nothing new');
  t.equal(again.report.rounds, 1, 'and stops after one round');
  t.end();
});

test('a prepared caller reaches a callee that only the prepared admission accepts without an asynchronous deopt', async (t) => {
  const dir = compileFixture(t);
  const jvm = new JVM({classpath: dir, jit: {compileWorker: false, asyncCallCensus: true}});
  await jvm.run('Caller');
  const work = findMethod(jvm, 'Callee', 'work', '(I)I');
  t.equal(jvm.jit.isCodegenSupported(work), false,
    'Callee.work is rejected by the adaptive (non-effectful) admission: it constructs a Helper');
  t.ok(jvm.jit.preparedCodegenMethods.has(work), 'but preparation compiled it');
  t.ok(jvm.jit.hasPublishedSynchronousBody(work), 'with a synchronous body');
  // The one asynchronous handoff Java requires: the first invokestatic into
  // Callee must run Callee's <clinit>, which preparation must not do early.
  const census = [...jvm.jit.asyncCallCensus]
    .filter(([key]) => key.includes('Callee.work'));
  t.deepEqual(census, [['Caller.loop(I)I@10 invokestatic Callee.work(I)I: class not initialized', 1]],
    'the only asynchronous handoff at the Callee.work site is the first-use class initialization, once');
  const loopDeopts = [...jvm.jit.preparedCodegenDeopts]
    .filter(([key]) => key.startsWith('Caller.loop(I)I:') && /asynchronous/.test(key))
    .map(([, count]) => count);
  t.deepEqual(loopDeopts, [1], 'and Caller.loop deopted exactly once for it, never for a missing synchronous entry');
  t.equal(jvm.classes.Caller.staticFields.get('result:I'), expected(200), 'correct result');
  t.end();
});

test('a method whose compile only succeeds once a dependency appears is picked up by a later round, and a never-compilable one ends the loop', async (t) => {
  const dir = compileFixture(t);
  const jvm = new JVM({classpath: dir, prepareBeforeMain: false, jit: {compileWorker: false}});
  await jvm.preloadClasspathClasses();
  const leaf = findMethod(jvm, 'Callee', 'leaf', '(I)I');
  const compute = findMethod(jvm, 'Helper', 'compute', '(I)I');
  // Simulate a dependency that is not ready in round 1: refuse `leaf` until
  // `compute` has a body, and refuse `compute` forever.
  const original = jvm.jit.getGeneratedFunction.bind(jvm.jit);
  let leafAttempts = 0, computeAttempts = 0;
  jvm.jit.getGeneratedFunction = (method, options) => {
    if (method === compute) { computeAttempts += 1; return null; }
    if (method === leaf) {
      leafAttempts += 1;
      if (leafAttempts === 1) return null;
    }
    return original(method, options);
  };
  const {report} = await jvm.precompileInitializedClasses({initializedOnly: false, effectful: true});
  t.ok(jvm.jit.preparedCodegenMethods.has(leaf), 'leaf was prepared on a later round');
  t.equal(leafAttempts, 2, 'after exactly one refusal');
  t.ok(report.rounds >= 2, `so the pass ran more than one round (${report.rounds})`);
  t.ok(report.rounds < 8, `and stopped on no-progress, not on the bound (${report.rounds})`);
  t.ok(report.unpreparedKeys.includes('Helper.compute(I)I'),
    `the never-compilable method is reported, not hidden (${report.unpreparedKeys.join(', ')})`);
  t.equal(computeAttempts, report.rounds, 'it was retried once per round and then given up on');
  t.end();
});

test('a pre-linked static JRE call does not run its shim before the class initializer', async (t) => {
  // Runtime.getRuntime() reads a static that Runtime's <clinit> shim stores.
  // Preparation links the site ahead of main; the first call must still
  // initialize the class first (the guest observed undefined and underflowed
  // its operand stack when it did not).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-clinit-'));
  t.teardown(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.writeFileSync(path.join(dir, 'RuntimeUser.java'), [
    'public class RuntimeUser {',
    '  static int processors;',
    '  static int probe(int n) {',
    '    int s = 0;',
    '    for (int i = 0; i < n; i++) { Runtime r = Runtime.getRuntime(); if (r != null) s += r.availableProcessors() > 0 ? 1 : 0; }',
    '    return s;',
    '  }',
    '  public static void main(String[] args) { processors = probe(5); }',
    '}',
  ].join('\n'));
  frontend.compileJavaFile(path.join(dir, 'RuntimeUser.java'), {outputDir: dir, sourceFileName: 'RuntimeUser.java'});
  const jvm = new JVM({classpath: dir, jit: {compileWorker: false, asyncCallCensus: true}});
  await jvm.run('RuntimeUser');
  t.equal(jvm.classes.RuntimeUser.staticFields.get('processors:I'), 5,
    'every Runtime.getRuntime() returned the runtime object');
  const underflows = jvm.jit.syncOperandUnderflowFallbackCount | 0;
  t.equal(underflows, 0, 'no generated call underflowed its operands');
  const site = [...jvm.jit.asyncCallCensus].filter(([k]) => k.includes('Runtime.getRuntime'));
  t.ok(site.every(([k]) => k.endsWith('class not initialized')) && site.length <= 1,
    `the only handoff at the site was the first-use initialization (${JSON.stringify(site)})`);
  t.end();
});

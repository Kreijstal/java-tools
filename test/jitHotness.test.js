// Phase 1.1 of docs/plan-linear-runtime.md: the hotness sampler replaces the
// invocation-count / loop-on-sight compile decision when JVM_JIT_HOTNESS=1
// (or jit.hotness: true). No threshold decides whether a method may compile;
// the periodic tick ranks decaying scores and compiles the top-N.
const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JVM } = require('../src/core/jvm');
const frontend = require('../src/java-frontend');

function compileProbe(t) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jit-hotness-'));
  t.teardown(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  frontend.compileJavaFile(path.resolve(__dirname, '../sources/HotnessProbe.java'), {
    outputDir, sourceFileName: 'HotnessProbe.java',
  });
  return outputDir;
}

function capture(jvm) {
  let out = '';
  jvm.registerJreMethods({ 'java/io/PrintStream': { 'println(I)V': (_j, _o, args) => { out += `${args[0]}\n`; } } });
  return () => out;
}

function methodsOf(jvm, className) {
  const items = jvm.classes[className]?.ast?.classes?.[0]?.items || [];
  const byName = {};
  for (const item of items) if (item.method) byName[item.method.name] = item.method;
  return byName;
}

test('hotness sampler compiles hot methods, loop-free included, and leaves cold ones alone', async (t) => {
  const classpath = compileProbe(t);
  const jvm = new JVM({ prepareBeforeMain: false, classpath, jit: {compileWorker: false,  profileMethods: true, hotness: true, hotnessTickMs: 5, hotnessTopN: 2 } });
  const out = capture(jvm);
  await jvm.run('HotnessProbe');
  const m = methodsOf(jvm, 'HotnessProbe');
  t.ok(jvm.jit.hotnessEnabled, 'sampler on');
  t.ok(jvm.jit.hotnessTickCount > 0, 'the scheduler ticked the sampler');
  t.ok(jvm.jit.isHotnessSelected(m.main), 'main (the interpreted loop) was selected by the tick');
  t.ok(jvm.jit.codegenCache.has(m.spin), 'spin() compiled (selected, or linked from main)');
  const stepCompiled = jvm.jit.codegenCache.has(m.step) ||
    jvm.jit.directInlineIntegerRegionCache?.get(m.step) || jvm.jit.inlineIntegerRegionCache?.get(m.step);
  t.ok(stepCompiled, 'step() has a compiled form (structured body or inline-integer region)');
  t.notOk(jvm.jit.isHotnessSelected(m.once), 'once() ran once and was never selected by the sampler');
  t.ok(jvm.jit.hotnessCompiledCount >= 1, `sampler compiled ${jvm.jit.hotnessCompiledCount} methods`);
  t.comment(`hotness: spin=${JSON.stringify(jvm.jit.hotness.get(m.spin))} step=${JSON.stringify(jvm.jit.hotness.get(m.step))} once=${JSON.stringify(jvm.jit.hotness.get(m.once))} codegen(once)=${jvm.jit.codegenCache.has(m.once)} ticks=${jvm.jit.hotnessTickCount} selected=${jvm.jit.hotnessSelectedCount}`);
  t.equal(out().trim(), String(expected()), 'program result unchanged');
  t.end();
});

test('with top-N 0 the sampler compiles nothing and the program still runs', async (t) => {
  const classpath = compileProbe(t);
  const jvm = new JVM({ prepareBeforeMain: false, classpath, jit: {compileWorker: false,  profileMethods: true, hotness: true, hotnessTickMs: 5, hotnessTopN: 0 } });
  const out = capture(jvm);
  await jvm.run('HotnessProbe');
  const m = methodsOf(jvm, 'HotnessProbe');
  t.notOk(jvm.jit.codegenCache.has(m.spin), 'spin() stays interpreted: nothing selects it');
  t.equal(jvm.jit.hotnessCompiledCount, 0, 'no sampler compiles');
  t.equal(out().trim(), String(expected()), 'program result unchanged');
  t.end();
});

test('sampler off keeps the invocation-count behaviour', async (t) => {
  const classpath = compileProbe(t);
  const jvm = new JVM({ prepareBeforeMain: false, classpath, jit: {compileWorker: false,  profileMethods: true, hotness: false } });
  const out = capture(jvm);
  await jvm.run('HotnessProbe');
  const m = methodsOf(jvm, 'HotnessProbe');
  t.notOk(jvm.jit.hotnessEnabled, 'sampler off');
  t.equal(jvm.jit.hotness.size, 0, 'no scores recorded');
  t.ok(jvm.jit.codegenCache.has(m.spin), 'loop-bearing spin() compiles on sight as before');
  t.equal(out().trim(), String(expected()), 'program result unchanged');
  t.end();
});

test('tick halves scores and forgets cold methods', (t) => {
  const jvm = new JVM({ prepareBeforeMain: false, jit: {compileWorker: false,  profileMethods: true, hotness: true, hotnessTickMs: 0, hotnessTopN: 0 } });
  const method = { name: 'm', descriptor: '()V', flags: ['static'], attributes: [] };
  jvm.jit.recordHotness(method, 8);
  t.equal(jvm.jit.hotness.get(method).score, 8);
  jvm.jit.hotnessTick(1);
  t.equal(jvm.jit.hotness.get(method).score, 4, 'halved');
  for (let i = 0; i < 12; i += 1) jvm.jit.hotnessTick(i + 2);
  t.notOk(jvm.jit.hotness.has(method), 'decayed entries are dropped');
  t.end();
});

function expected() {
  const step = (x) => ((Math.imul(x, 31) + 7) & 0xffff);
  const spin = (n) => { let acc = 0; for (let i = 0; i < n; i += 1) acc = step(acc + i); return acc; };
  let acc = 1;
  for (let round = 0; round < 400; round += 1) acc = (spin(64) + step(acc)) | 0;
  return acc;
}

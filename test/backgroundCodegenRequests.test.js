'use strict';
const test = require('tape');
const { JVM } = require('../src/core/jvm');

function setup(t) {
  const jvm = new JVM({ jit: { compileWorker: false, backgroundCodegen: true } });
  t.teardown(() => jvm.jit.compileWorker.dispose());
  const jit = jvm.jit;
  const method = { className: 'BackgroundProbe', name: 'value',
    descriptor: '()I', flags: ['static'], attributes: [{type: 'code', code: {
      codeItems: ['iconst_1', 'ireturn'].map((instruction, i) =>
        ({labelDef: `L${i}:`, instruction})),
      localsSize: '0', stackSize: '1', exceptionTable: [],
    }}] };
  return {jvm, jit, method};
}

test('runtime body lookup never compiles on worker refusal or absence', t => {
  const {jvm, jit, method} = setup(t);
  const originalCompile = jit.compileMethod.bind(jit);
  let compiles = 0;
  jit.compileMethod = (...args) => { compiles++; return originalCompile(...args); };
  t.ok(jit.getGeneratedFunction(method, {compileLocally: true}), 'pre-main preparation remains valid');
  t.equal(compiles, 1, 'prepared once');
  jit.codegenCache.delete(method);
  jit.markMainStarted();
  for (const enabled of [false, true]) {
    jit.compileWorker.enabled = enabled;
    jit.compileWorker.enqueue = () => false;
    t.equal(jit.getGeneratedFunction(method, {compileLocally: true,
      allowEffectfulCalls: true}), null, 'unavailable optimization leaves interpreter entry');
  }
  t.equal(compiles, 1, 'neither explicit local option nor refusal compiles after main');
  t.equal(jit.workerUnservedPostMainMethodCount, 1, 'unserved methods counted distinctly');
  jit.mainStarted = false; jvm.guestStarted = true;
  t.equal(jit.getGeneratedFunction(method), null, 'guest-start boundary independently enforced');
  t.equal(compiles, 1, 'no compilation through alternate boundary');
  t.end();
});

test('execution retains its body while requesting an upgrade', t => {
  const {jit, method} = setup(t);
  const baseline = () => 1;
  jit.codegenCache.set(method, baseline);
  jit.markMainStarted();
  let request;
  jit.compileWorker.enqueue = (m, options) => {request = {m, options}; return true;};
  t.equal(jit.getGeneratedFunction(method), baseline, 'ready body executes without a request');
  t.notOk(request, 'ordinary cached entry does not enqueue');
  jit.codegenEnabled = false;
  t.equal(jit.getGeneratedFunction(method), null, 'disabled codegen does not expose a cached body');
  jit.codegenEnabled = true;
  t.equal(jit.getGeneratedFunction(method, {allowEffectfulCalls: true}), baseline,
    'upgrade request returns existing executable immediately');
  t.equal(request.options.replacementOf, baseline, 'request identifies the publication it may replace');
  t.equal(jit.codegenCache.get(method), baseline, 'no stop-and-recompile cache eviction');
  jit.structuredSsa.compile = () => {throw Error('foreground compiler ran');};
  jit.scheduleStructuredCacheUpgrade(method, baseline);
  t.equal(jit.codegenCache.get(method), baseline, 'constructor promotion also retains current entry');
  t.end();
});

test('a real queue send failure never authorizes foreground compilation', t => {
  const {jit, method} = setup(t);
  const worker = jit.compileWorker;
  worker.enabled = true;
  worker.ensureWorker = () => ({postMessage() {throw Error('unavailable worker host');},
    ref() {}, unref() {}});
  jit.markMainStarted();
  jit.compileMethod = () => {throw Error('foreground compiler ran');};
  t.equal(jit.getGeneratedFunction(method), null, 'first request keeps lower-tier execution');
  t.equal(worker.stats.failed, 1, 'request actually passed through the failing send path');
  t.ok(worker.declined.has(method), 'failed request is retired instead of sent per invocation');
  t.equal(jit.getGeneratedFunction(method), null, 'next invocation still does not compile');
  t.equal(worker.stats.failed, 1, 'failure is not retried on every call');
  t.end();
});

test('worker publication replaces only the body captured by its request', t => {
  const {jit, method} = setup(t);
  const worker = jit.compileWorker;
  const baseline = () => 1, replacement = () => 2, newer = () => 3;
  worker.pump = () => {};
  jit.materializeGeneratedResult = () => replacement;
  const published = [];
  jit.publishGeneratedTargetUpgrade = (m, body) => published.push(body);
  function deliver(current, id, payload = {}) {
    jit.codegenCache.set(method, current);
    worker.inFlight.set(method, {id, entry: {method, replacementOf: baseline,
      preparedWholeMethod: true, retriedAfterStale: true}});
    worker.receive({type: 'result', id, payload});
  }
  deliver(baseline, 1);
  t.equal(jit.codegenCache.get(method), replacement, 'valid completed replacement publishes');
  t.equal(published[0], replacement, 'warmed call targets are notified');
  t.ok(jit.preparedCodegenMethods.has(method), 'prepared provenance is retained');
  deliver(newer, 2);
  t.equal(jit.codegenCache.get(method), newer, 'an intervening publication wins');
  t.equal(worker.stats.superseded, 1, 'lost race is recorded');
  jit.materializeGeneratedResult = () => null;
  deliver(baseline, 3);
  t.equal(jit.codegenCache.get(method), baseline, 'invalid replacement leaves executable intact');
  t.equal(published.length, 1, 'rejected results never relink callers');
  t.end();
});

test('a promotion scheduled before main respects the boundary at callback time', async t => {
  const {jit, method} = setup(t);
  const baseline = () => 1;
  jit.codegenCache.set(method, baseline);
  let requests = 0, compiles = 0;
  jit.compileWorker.enqueue = () => {requests++; return true;};
  jit.structuredSsa.compile = () => {compiles++; return null;};
  jit.scheduleStructuredCacheUpgrade(method, baseline);
  jit.markMainStarted();
  await new Promise(resolve => setTimeout(resolve, 10));
  t.equal(compiles, 0, 'a deferred callback is not a background compiler');
  t.equal(requests, 1, 'callback requests actual worker execution');
  t.equal(jit.codegenCache.get(method), baseline, 'the guest still has its body');
  t.end();
});

test('a real worker replaces a retained body with identical execution results', async t => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const frontend = require('../src/java-frontend');
  const Frame = require('../src/core/frame');
  const CallStack = require('../src/core/callStack');
  const classpath = fs.mkdtempSync(path.join(os.tmpdir(), 'background-upgrade-'));
  t.teardown(() => fs.rmSync(classpath, {recursive: true, force: true}));
  frontend.compileJavaFile(path.resolve(__dirname, '../sources/HotnessProbe.java'),
    {outputDir: classpath, sourceFileName: 'HotnessProbe.java'});
  const jvm = new JVM({classpath, jit: {backgroundCodegen: true, compileWorker: true}});
  const jit = jvm.jit;
  t.teardown(() => jit.compileWorker.dispose());
  await jvm.loadClassByName('HotnessProbe');
  const method = await jvm.findMethodInHierarchy('HotnessProbe', 'once', '(I)I');
  const baseline = jit.getGeneratedFunction(method, {compileLocally: true});
  t.ok(baseline, 'a baseline exists before main');
  jit.markMainStarted(); jvm.guestStarted = true;
  t.equal(jit.getGeneratedFunction(method, {allowEffectfulCalls: true}), baseline,
    'real worker request returns the retained body');
  // Test coordination only: the guest-facing request above never awaits this.
  await jit.compileWorker.whenIdle();
  const replacement = jit.getGeneratedFunction(method);
  t.ok(jit.compileWorker.installedMethods.has(method),
    'replacement was actually transported: ' + jit.compileWorker.lastRefusal);
  t.notEqual(replacement, baseline, 'the prepared body replaced the captured baseline');
  for (const value of [0, -17, 2147483647]) {
    const run = body => {
      const frame = new Frame(method); frame.className = 'HotnessProbe'; frame.locals[0] = value;
      const thread = {id: 1, status: 'runnable', callStack: new CallStack()};
      thread.callStack.push(frame);
      return body(frame, thread, jit, false).value;
    };
    t.equal(run(replacement), run(baseline), 'replacement preserves integer result for ' + value);
    t.equal(run(replacement), (value + 1) | 0, 'result is independently checked');
  }
  t.equal(jit.postMainSyncCompileCount, 0, 'no foreground optimization during request/publication/execution');
  t.end();
});

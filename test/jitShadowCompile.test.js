// Phase 1.4 of docs/plan-linear-runtime.md: the compile worker, verified in
// process. A SECOND JVM instance plays the worker's shadow JVM: it loads the
// same classes, pre-creates the static-field keys of the classes the request
// reports initialized (it cannot run <clinit>), compiles the method, and hands
// back only plain data. The main JIT rebuilds an equivalent generated object
// from that data and must execute exactly like its own compile.
const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const frontend = require('../src/java-frontend');

function compileProbe(t) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jit-shadow-'));
  t.teardown(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  frontend.compileJavaFile(path.resolve(__dirname, '../sources/CaptureProbe.java'), {
    outputDir, sourceFileName: 'CaptureProbe.java',
  });
  return outputDir;
}

function methodsOf(jvm, className) {
  const items = jvm.classes[className].ast.classes[0].items;
  const out = {};
  for (const item of items) {
    if (item?.type === 'method') out[item.method.name] = item.method;
  }
  return out;
}

// The shadow JVM of the plan's 1.2: same classpath, no guest execution.
async function bootShadow(classpath, request) {
  // A shadow JIT stands in for the compile worker: it compiles in this thread
  // and hands back a transportable result. Letting it enqueue to a worker of
  // its own defeats that - getGeneratedFunction returns null once the worker
  // accepts a method, so there would be nothing to serialize.
  const shadow = new JVM({ classpath,
    jit: { profileMethods: true, warmupThreshold: 0, compileWorker: false } });
  const classData = await shadow.loadClassByName(request.className);
  for (const className of request.initializedClasses) {
    const data = shadow.classes[className];
    if (!data?.ast) continue;
    // A shadow JVM cannot run <clinit>. Declaring the static keys with their
    // default values is what resolveStaticFieldSite needs to hand generated
    // code a value cell instead of degrading to the slow path.
    for (const item of data.ast.classes[0].items) {
      if (item?.type !== 'field' || !item.field.flags?.includes('static')) continue;
      const key = `${item.field.name}:${item.field.descriptor}`;
      if (!data.staticFields.has(key)) data.staticFields.set(key, 0);
    }
    shadow.classInitializationState.set(className, 'INITIALIZED');
  }
  return { shadow, classData };
}

test('a shadow JVM compiles a method and the main JIT rebuilds it from plain data', async (t) => {
  const classpath = compileProbe(t);
  const jvm = new JVM({ classpath, jit: { profileMethods: true, warmupThreshold: 0 } });
  jvm.registerJreMethods({ 'java/io/PrintStream': { 'println(I)V': () => {} } });
  await jvm.run('CaptureProbe');
  const jit = jvm.jit;
  const main = methodsOf(jvm, 'CaptureProbe');

  const request = {
    className: 'CaptureProbe',
    methodName: 'walk',
    descriptor: '(LCaptureProbe;I)I',
    initializedClasses: [...jvm.classInitializationState]
      .filter(([, state]) => state === 'INITIALIZED').map(([name]) => name),
  };
  const { shadow } = await bootShadow(classpath, request);
  const shadowMethods = methodsOf(shadow, 'CaptureProbe');
  const shadowMethod = shadowMethods[request.methodName];
  t.ok(shadowMethod, 'the shadow JVM loaded the same method');
  t.notEqual(shadowMethod, main.walk, 'it is a different method object');

  const shadowGenerated = shadow.jit.getGeneratedFunction(shadowMethod);
  t.ok(shadowGenerated, 'the shadow JIT compiled it without any guest run');

  const payload = shadow.jit.serializeGeneratedResult(shadowGenerated);
  t.ok(payload, 'the result serializes');
  // The transport must be plain data: no live object of the shadow JVM may
  // appear in it (this is what a structured clone would enforce in a Worker).
  const roundTripped = JSON.parse(JSON.stringify(payload));
  t.comment(`payload kind=${payload.kind} bytes=${JSON.stringify(payload).length}` +
    ` dropped=${JSON.stringify(payload.dropped || (payload.fast || {}).dropped || [])}`);

  const rebuilt = jit.materializeGeneratedResult(roundTripped, main.walk);
  t.equal(typeof rebuilt, 'function', 'the main JIT rebuilds a function');

  const reference = jit.codegenCache.get(main.walk);
  const referenceBody = reference.jvmRestoringDirectPositionalBody;
  const rebuiltBody = rebuilt.jvmRestoringDirectPositionalBody;
  t.equal(typeof rebuiltBody, 'function',
    'the transported result carries the restoring positional tier');

  const store = jvm.classes.CaptureProbe.staticFields;
  const callsCell = store.cell('calls:I');
  const thread = { status: 'runnable', callStack: { items: [],
    peek() { return this.items[this.items.length - 1]; },
    push(f) { this.items.push(f); }, pop() { return this.items.pop(); } } };
  const plan = {
    target: {}, Frame, method: main.walk, lookupClass: 'CaptureProbe',
    restoreFrame() {}, clearStructuredContinuation: null,
    semantic: reference.jvmRestoringDirectPositionalPlan || null,
  };
  // walk() writes p.field, so each body gets its own identical receiver.
  const newReceiver = () =>
    ({ type: 'CaptureProbe', _className: 'CaptureProbe', fields: { 'field:I': 0 } });
  const before = callsCell.value;
  const expected = referenceBody(jit, plan, newReceiver(), 16, thread, true);
  const afterReference = callsCell.value;
  const actual = rebuiltBody(jit, plan, newReceiver(), 16, thread, true);
  const afterRebuilt = callsCell.value;
  t.comment(`reference=${expected} transported=${actual} ` +
    `calls ${before}->${afterReference}->${afterRebuilt}`);
  t.equal(actual, expected, 'the transported body returns the same value');
  t.equal(afterRebuilt - afterReference, afterReference - before,
    'it writes the main JVM\'s own static cell by the same amount');
  t.end();
});

test('a transported result carries every tier the local compile published', async (t) => {
  const classpath = compileProbe(t);
  const jvm = new JVM({ classpath, jit: { profileMethods: true, warmupThreshold: 0 } });
  jvm.registerJreMethods({ 'java/io/PrintStream': { 'println(I)V': () => {} } });
  await jvm.run('CaptureProbe');
  const main = methodsOf(jvm, 'CaptureProbe');
  const missing = [];
  const dropped = new Set();
  for (const [name, method] of Object.entries(main)) {
    const generated = jvm.jit.codegenCache.get(method);
    if (!generated) continue;
    const payload = jvm.jit.serializeGeneratedResult(generated);
    if (!payload) { missing.push(`${name}: not serializable`); continue; }
    for (const key of payload.dropped || []) dropped.add(key);
    for (const key of (payload.fast?.dropped || [])) dropped.add(key);
    for (const key of (payload.resume?.dropped || [])) dropped.add(key);
    const rebuilt = jvm.jit.materializeGeneratedResult(
      JSON.parse(JSON.stringify(payload)), method);
    for (const key of Object.keys(generated)) {
      if (typeof generated[key] !== 'function') continue;
      if (key === 'toString') continue;
      if (typeof rebuilt[key] !== 'function') missing.push(`${name}.${key}`);
    }
  }
  t.comment(`dropped on transport: ${[...dropped].sort().join(', ') || '(none)'}`);
  t.deepEqual(missing, [], 'no function tier is lost on transport');
  t.end();
});

test('a result compiled against a different world is refused, not installed', async (t) => {
  const classpath = compileProbe(t);
  const jvm = new JVM({ classpath, jit: { profileMethods: true, warmupThreshold: 0 } });
  jvm.registerJreMethods({ 'java/io/PrintStream': { 'println(I)V': () => {} } });
  await jvm.run('CaptureProbe');
  const jit = jvm.jit;
  const main = methodsOf(jvm, 'CaptureProbe');
  const generated = jit.codegenCache.get(main.walk);
  const payload = jit.serializeGeneratedResult(generated);
  t.ok(payload.provenance, 'the payload records what the compile assumed');

  t.equal(jit.resultStalenessReason(payload), null,
    'an unchanged world accepts the result');
  t.ok(jit.materializeGeneratedResult(payload, main.walk),
    'and it materializes');

  // A class registered after the compile does NOT invalidate the body. Its
  // call sites arrive cold, its field and static targets are re-resolved
  // here, and both speculation kinds re-read their cell at entry, so there is
  // nothing for a new class to falsify. Discarding on the bare epoch made an
  // asynchronous compile lose a race it can never win -- classes load
  // continuously during a boot -- and a worker run threw away 172 of 498
  // finished bodies here, recompiling every one on the main thread.
  jvm.bumpClassEpoch();
  t.equal(jit.resultStalenessReason(payload), null,
    'a moved class epoch alone does not invalidate a transported body');
  t.ok(jit.materializeGeneratedResult(payload, main.walk),
    'and the body still installs');

  // Eager monomorphic linking is the exception: it primes fastPositional from
  // the world as it stands, with no guard of its own, so a result that
  // carries one is still refused once the world moves.
  const speculative = jit.serializeGeneratedResult(generated);
  speculative.provenance.epochSensitive = true;
  speculative.provenance.classEpoch = jvm.classEpoch - 1;
  const epochReason = jit.resultStalenessReason(speculative);
  t.ok(epochReason && epochReason.includes('class epoch moved'),
    `an epoch-sensitive result is stale once the epoch moves: ${epochReason}`);
  t.equal(jit.materializeGeneratedResult(speculative, main.walk), null,
    'a stale epoch-sensitive result is refused rather than installed');
  t.ok(jit.staleTransportedResults >= 1, 'the refusal is counted');

  // A compile that assumed a class was initialized when this thread has not
  // initialized it is refused too.
  const fresh = jit.serializeGeneratedResult(generated);
  fresh.provenance.initializedClasses = [
    ...fresh.provenance.initializedClasses, 'NeverInitialized'];
  const initReason = jit.resultStalenessReason(fresh);
  t.ok(initReason && initReason.includes('NeverInitialized'),
    `an uninitialized assumption is stale: ${initReason}`);

  // A payload with no provenance at all is refused rather than trusted.
  const bare = jit.serializeGeneratedResult(generated);
  delete bare.provenance;
  t.ok(jit.resultStalenessReason(bare), 'a payload without provenance is stale');
  t.end();
});

const test = require('tape');
const Retention = require('../src/jit/InstalledSourceRetention');
const {CompileWorkerClient} = require('../src/jit/CompileWorkerClient');

test('source exhaustion preserves executable bodies and continuation metadata', t => {
  const policy = new Retention({generatedCodeBudgetBytes: 4});
  const first = Object.assign(() => 7, {jvmGeneratedSource: 'ab'});
  const replacement = Object.assign(() => 9, {
    jvmGeneratedSource: 'abc', jvmCaptureDescriptors: {},
    jvmHasOwnedStructuredContinuation: () => true,
  });
  policy.apply(first);
  policy.apply(first);
  policy.apply(replacement);
  t.equal(policy.bytes, 4, 'shared/revisited bodies charged once');
  t.equal(replacement.jvmGeneratedSource, undefined, 'over-budget source released');
  t.equal(replacement.jvmCaptureDescriptors, undefined, 'transport descriptors released');
  t.equal(replacement(), 9, 'replacement still executes');
  t.equal(first(), 7, 'old body held by a running frame remains executable');
  t.ok(replacement.jvmHasOwnedStructuredContinuation(), 'continuation helper preserved');
  t.throws(() => new Retention({generatedCodeBudgetBytes: NaN}), RangeError);
  t.end();
});

test('diagnostic opt-out strips nested bodies without traversing execution state', t => {
  const policy = new Retention({retainInstalledSource: false});
  const child = Object.assign(() => 3, {jvmGeneratedSource: 'abc'});
  const body = Object.assign(() => child(), {jvmFastBody: child});
  body.jvmResumeBodyFn = body;
  policy.apply(body);
  t.equal(policy.bytes, 0);
  t.equal(child.jvmGeneratedSource, undefined);
  t.equal(body(), 3);
  t.end();
});

test('bounded queue retries backpressure and discards superseded payload before binding', t => {
  const jit = {jvm: {}, codegenCache: new WeakMap()};
  const client = new CompileWorkerClient(jit, {compileWorkerMaxQueued: 1});
  client.pump = () => {};
  const a = {className: 'A'}, b = {className: 'B'};
  t.equal(client.maxInFlight, 1);
  t.ok(client.enqueue(a));
  t.notOk(client.enqueue(b));
  t.equal(client.queue.length, 1);
  t.notOk(client.declined.has(b), 'backpressure does not permanently refuse');
  client.queue.length = 0;
  t.ok(client.enqueue(b), 'retry admitted after capacity becomes available');
  const winner = () => 42;
  jit.codegenCache.set(a, winner);
  client.inFlight.set(a, {id: 1, entry: {replacementOf: () => 0}});
  const message = {type: 'result', id: 1, payload: {}};
  client.receive(message);
  t.equal(jit.codegenCache.get(a), winner, 'newer body preserved');
  t.equal(message.payload, null, 'losing payload released without materialization');
  t.equal(client.stats.superseded, 1);
  t.end();
});

test('transport omits disposable source metadata but preserves executable source', t => {
  const {JVM} = require('../src/core/jvm');
  for (const retainCompilerDiagnostics of [false, true]) {
    const jvm = new JVM({jit: {compileWorker: false, retainCompilerDiagnostics}});
    const method = {className: 'TransportProbe', name: 'add', descriptor: '(I)I', attributes: []};
    const body = jvm.jit.createGeneratedFunction(method, 'probe', ['value'], 'return value + 1;');
    body.jvmStructuredSource = 'diagnostic-only-source';
    body.jvmSynchronous = true;
    const payload = jvm.jit.serializeGeneratedResult(body);
    t.ok(payload, 'body remains transportable');
    t.equal(payload.data.jvmStructuredSource, retainCompilerDiagnostics ? 'diagnostic-only-source' : undefined,
      'source metadata follows the retention policy');
    t.equal(payload.bodies.own.source, body.jvmGeneratedSource, 'executable source and source URL are retained');
    const rebound = jvm.jit.materializeGeneratedResult(payload, method);
    t.equal(rebound(3), 4, 'transported body executes identically');
    t.ok(rebound.jvmSynchronous, 'execution metadata is retained');
  }
  t.end();
});

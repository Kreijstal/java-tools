const test = require('tape');
const {JVM} = require('../src/core/jvm');

test('transport compilation retains source without constructing executable guest bodies', t => {
  const sender = new JVM({jit: {compileWorker: false, producesTransport: true, compilePhaseTiming: true}}).jit;
  const receiver = new JVM({jit: {compileWorker: false}}).jit;
  receiver.jvm.guestStarted = true;
  const method = {name: 'score', descriptor: '(I)I', className: 'SourceOnly'};
  for (const generator of [false, true]) {
    const body = sender.createGeneratedFunction(method, 'source-only-test', ['n'],
      generator ? 'yield twice(n); return n + 1;' : 'return twice(n);',
      'SourceOnly', false, generator, null, 'function twice(n) { return n * 2; }');
    t.throws(() => body(4), /Transport-only/, 'worker record cannot run guest code');
    t.equal(body.length, 1, 'parameter arity is retained');
    const spec = sender.serializeTextBody(body);
    t.equal(spec.generator, generator, 'execution kind crosses as metadata');
    const executable = receiver.materializeTextBody(structuredClone(spec), method);
    if (generator) {
      const iterator = executable(4);
      t.deepEqual(iterator.next(), {value: 8, done: false}, 'receiver executes generator and hoisted helper');
      t.deepEqual(iterator.next(), {value: 5, done: true}, 'receiver preserves continuation return');
    } else {
      t.equal(executable(4), 8, 'receiver executes source with its hoisted helper');
    }
  }
  t.notOk(sender.compilePhaseStats.has('newFunction'), 'worker skips executable construction');
  t.end();
});

test('invalid transported syntax is refused before publication', t => {
  const sender = new JVM({jit: {compileWorker: false, producesTransport: true}}).jit;
  const receiver = new JVM({jit: {compileWorker: false}}).jit;
  const method = {name: 'broken', descriptor: '()V', className: 'SourceOnly'};
  const body = sender.createGeneratedFunction(method, 'source-only-test', [], 'return (;');
  const payload = sender.serializeGeneratedResult(body);
  t.ok(payload, 'worker carries source without eagerly compiling it');
  t.equal(receiver.materializeGeneratedResult(payload, method), null, 'receiver refuses invalid syntax');
  t.match(receiver.lastTransportRefusal, /invalid generated source/, 'refusal identifies syntax validation');
  t.notOk(receiver.codegenCache.has(method), 'no invalid body is published');
  t.end();
});

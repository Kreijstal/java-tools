const test = require('tape');
const {Unsupported, blockedNames} = require('../src/jit/wasmShared');

test('Wasm refusal signals preserve type and blockers without native error construction', t => {
  const descriptor = Object.getOwnPropertyDescriptor(Error, 'stackTraceLimit');
  let accesses = 0;
  Object.defineProperty(Error, 'stackTraceLimit', {configurable: true,
    get() { accesses++; return 10; }, set() { accesses++; }});
  let signal;
  try { signal = new Unsupported('dependency pending', ['A', 'B.run()V']); }
  finally { Object.defineProperty(Error, 'stackTraceLimit', descriptor); }
  t.equal(accesses, 0, 'does not change global error behavior');
  t.ok(signal instanceof Unsupported && signal instanceof Error, 'existing catch predicates still work');
  t.equal(String(signal), 'Error: dependency pending', 'message formatting is preserved');
  t.deepEqual(blockedNames(signal), ['A', 'B.run()V'], 'dependency tracking is preserved');
  t.notOk(Object.hasOwn(signal, 'stack'), 'no stack is captured');
  class Specialized extends Unsupported {}
  t.ok(new Specialized('x') instanceof Specialized, 'subclasses keep their prototype');
  t.equal(new Unsupported().message, '', 'missing message keeps Error default');
  t.end();
});

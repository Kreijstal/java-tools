const test = require('tape');
const { ClassMirrorEncoder, ClassMirrorDecoder } = require('../src/jit/ClassMirrorTransport');
const { JVM } = require('../src/core/jvm');
const frontend = require('../src/java-frontend');
const fs = require('fs');
const os = require('os');
const path = require('path');

function roundTrip(value, limit = 32) {
  const encoder = new ClassMirrorEncoder(value), decoder = new ClassMirrorDecoder();
  let count = 0, maximum = 0;
  for (;;) {
    const packet = encoder.next(limit, Infinity);
    maximum = Math.max(maximum, packet.records.length / 4);
    const result = decoder.accept(structuredClone(packet));
    count++;
    if (packet.done) return { result, count, maximum, decoder };
  }
}

test('class transport preserves graph identity, values, sparse arrays and prototype keys', t => {
  const shared = { nan: NaN, negativeZero: -0, bigint: 42n, missing: undefined };
  const input = { shared, alias: shared, sparse: new Array(10), map: new Map(), set: new Set() };
  input.self = input;
  input.sparse[4] = shared;
  input.map.set(shared, input);
  input.set.add(input.map);
  Object.defineProperty(input, '__proto__', { value: shared, enumerable: true });
  const { result, count, decoder } = roundTrip(input, 3);
  t.deepEqual(result, structuredClone(input), 'same graph as native structured clone');
  t.equal(result.shared, result.alias, 'aliases survive packet boundaries');
  t.equal(result.self, result, 'cycles survive');
  t.equal(result.map.get(result.shared), result, 'map keys share identity');
  t.equal(result.sparse.length, 10, 'sparse array length preserved');
  t.notOk(0 in result.sparse, 'holes are not materialized');
  t.equal(Object.getPrototypeOf(result), Object.prototype, 'prototype not changed by data');
  t.ok(count > 1, 'test actually crosses packets');
  t.equal(decoder.objects.length, 0, 'decoder releases graph index when complete');
  t.end();
});

test('one large method is split into bounded shallow packets', t => {
  const input = { ast: { classes: [{ items: [{ method: { codeItems:
    Array.from({ length: 10000 }, (_, i) => ({ instruction: 'ldc', value: i })) } }] }] } };
  const { result, count, maximum } = roundTrip(input, 128);
  t.deepEqual(result, input, 'complete code reconstructed');
  t.ok(count > 100, 'splits within a method');
  t.ok(maximum <= 130, 'at most one edge and its two newly referenced nodes over the bound');
  t.end();
});

test('browser class mirror protocol works with a real compiler worker', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'class-mirror-'));
  const jvm = new JVM({ classpath: dir, prepareBeforeMain: false,
    jit: { profileMethods: true, compileWorker: true, warmupThreshold: 0 } });
  const client = jvm.jit.compileWorker;
  t.teardown(async () => { await client.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  frontend.compileJavaFile(path.resolve(__dirname, '../sources/HotnessProbe.java'),
    { outputDir: dir, sourceFileName: 'HotnessProbe.java' });
  const nodeHost = client.createNodeWorkerHost.bind(client);
  let packets = 0, outstanding = 0, maxOutstanding = 0;
  client.createNodeWorkerHost = () => {
    const host = nodeHost(), send = host.postMessage, receive = host.onMessage;
    host.kind = 'web-worker';
    host.postMessage = message => {
      if (message.type === 'class-mirror') { packets++; maxOutstanding = Math.max(maxOutstanding, ++outstanding); }
      if (message.type === 'compile') t.notOk(message.classes.some(c => c.ast), 'compile message contains no AST graphs');
      send(message);
    };
    host.onMessage = callback => receive(message => {
      if (message.type === 'class-mirrored') outstanding--;
      callback(message);
    });
    return host;
  };
  let output = '';
  jvm.registerJreMethods({ 'java/io/PrintStream': { 'println(I)V': (_j, _o, args) => { output += args[0] + '\n'; } } });
  await jvm.run('HotnessProbe');
  await client.whenIdle();
  t.ok(packets > 1, 'used class mirror packets');
  t.equal(maxOutstanding, 1, 'only one packet unacknowledged');
  t.ok(client.stats.installed > 0, 'worker compiled and installed a body');
  t.equal(client.stats.failed, 0, 'no protocol errors');
  t.equal(client.stats.refused, 0, 'no compiler refusals');
  t.equal(client.classMirror, null, 'sender releases completed transfer');
  const plain = new JVM({ classpath: dir, jit: { compileWorker: false } });
  let expected = '';
  plain.registerJreMethods({ 'java/io/PrintStream': { 'println(I)V': (_j, _o, args) => { expected += args[0] + '\n'; } } });
  await plain.run('HotnessProbe');
  t.equal(output, expected, 'execution agrees with local compilation');
  t.end();
});

test('typed views retain their shared backing buffer across packets', t => {
  const buffer = new ArrayBuffer(32), a = new Uint8Array(buffer, 4, 8), b = new DataView(buffer, 2, 12);
  a[0] = 37;
  const { result } = roundTrip({ a, b, buffer }, 2);
  t.deepEqual(result, structuredClone({ a, b, buffer }), 'views and contents copied');
  t.equal(result.a.buffer, result.buffer, 'typed array aliases the buffer');
  t.equal(result.b.buffer, result.buffer, 'DataView aliases the buffer');
  t.end();
});

const { CompileWorkerClient } = require('../src/jit/CompileWorkerClient');
function mirrorFixture(classes, onPacket = () => {}) {
  const jvm = { classes, classInitializationState: new Map() };
  const client = new CompileWorkerClient({ jvm });
  let decoder = null, mirrorId = null;
  const received = [];
  const host = { kind: 'web-worker', ref() {}, unref() {}, terminate: async () => {},
    postMessage(message) {
      if (message.type === 'class-mirror-abort') { decoder = null; return; }
      const wire = structuredClone(message);
      setTimeout(() => {
        if (mirrorId !== wire.id) { decoder = new ClassMirrorDecoder(); mirrorId = wire.id; }
        const entry = decoder.accept(wire.packet);
        if (wire.packet.done) received.push(entry);
        onPacket(wire, client);
        client.receive({ type: 'class-mirrored', id: wire.id, sequence: wire.sequence });
      }, 0);
    } };
  client.worker = host;
  return { client, host, received };
}

test('class replacement during mirroring remains pending and booleans are refreshed', async t => {
  const first = { classes: [{ items: [] }] }, replacement = { classes: [{ items: [{ newMethod: true }] }] };
  const classes = { Example: { ast: first, staticFields: new Map([['flag:Z', 0]]) } };
  let changed = false;
  const { client, host, received } = mirrorFixture(classes, () => {
    if (!changed) {
      t.equal(client.sentClasses.size, 0, 'not marked delivered before acknowledgement');
      classes.Example.ast = replacement;
      classes.Example.staticFields.set('flag:Z', 1);
      changed = true;
    }
  });
  client.jvm.classInitializationState.set('Example', 'INITIALIZED');
  client.startClassMirror(host, client.pendingClasses());
  await client.whenIdle();
  t.deepEqual(received[0].ast, first, 'worker received original graph');
  t.equal(client.sentClassAsts.get(first), 'Example', 'only captured identity committed');
  const pending = client.pendingClasses();
  t.equal(pending[0].ast, replacement, 'replacement is still pending');
  t.deepEqual(pending[0].staticBooleans, [['flag:Z', 1]], 'current booleans re-snapshotted');
  client.startClassMirror(host, pending);
  await client.whenIdle();
  t.equal(client.pendingClasses()[0].ast, undefined, 'replacement sent once');
  t.equal(client.classMirror, null, 'no transport payload retained');
  t.end();
});

test('failed packets quarantine only their class and release the transfer', async t => {
  const { client, host, received } = mirrorFixture({
    Bad: { ast: { cannotClone() {} } }, Good: { ast: { classes: [] } },
  });
  client.startClassMirror(host, client.pendingClasses());
  await client.whenIdle();
  t.ok(client.unsendableClasses.has('Bad'), 'bad class quarantined');
  t.notOk(client.sentClasses.has('Bad'), 'failed class not marked delivered');
  t.ok(client.sentClasses.has('Good'), 'remaining class delivered');
  t.equal(received.length, 1, 'partial class never installed');
  t.equal(client.classMirror, null, 'failed graph and encoder released');
  t.end();
});

test('disposal cancels scheduled transport, retires queued work and settles idle', async t => {
  const { client, host } = mirrorFixture({ Example: { ast: { classes: [] } } });
  let sends = 0;
  host.postMessage = () => { sends++; };
  const method = {};
  client.queue.push({ method });
  client.queued.add(method);
  client.startClassMirror(host, client.pendingClasses());
  const idle = client.whenIdle();
  await client.dispose();
  await idle;
  await new Promise(resolve => setTimeout(resolve, 10));
  t.equal(sends, 0, 'cancelled timer sends nothing');
  t.equal(client.classMirror, null, 'partial sender graph released');
  t.ok(client.declined.has(method), 'cancelled method can use existing fallback');
  t.ok(client.idle, 'no stranded queued work');
  t.end();
});

test('worker failure cancels a class mirror and does not strand queued methods', async t => {
  const client = new CompileWorkerClient({ jvm: { classes: { Example: { ast: {} } },
    classInitializationState: new Map() } });
  let fail, terminated = false;
  client.createNodeWorkerHost = () => ({ kind: 'web-worker', ref() {}, unref() {},
    onMessage() {}, onError(callback) { fail = callback; }, postMessage() {},
    async terminate() { terminated = true; } });
  const host = client.ensureWorker(), method = {};
  client.queue.push({ method });
  client.queued.add(method);
  client.startClassMirror(host, client.pendingClasses());
  const idle = client.whenIdle();
  fail(new Error('worker stopped'));
  await idle;
  t.ok(client.idle, 'idle wait resolves after failure');
  t.equal(client.classMirror, null, 'partial transfer released');
  t.ok(client.declined.has(method), 'method no longer waits for a dead worker');
  t.equal(client.sentClasses.size, 0, 'replacement worker must receive classes again');
  t.ok(terminated, 'failed worker is terminated');
  t.end();
});

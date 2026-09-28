const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {JVM} = require('../src/core/jvm');

function method(name, value) {
  return {className: 'MirrorProbe', name, descriptor: '()I', flags: ['static'],
    attributes: [{type: 'code', code: {localsSize: '0', stackSize: '1', exceptionTable: [],
      codeItems: [{instruction: 'bipush', operand: String(value)}, {instruction: 'ireturn'}]}}]};
}
function record(methods) {
  return {staticFields: new Map(), ast: {classes: [{className: 'MirrorProbe',
    superClassName: 'java/lang/Object', items: methods.map(method => ({type: 'method', method}))}]}};
}

for (const browserMirror of [false, true]) test(`worker refreshes a class mirror when a stub AST is replaced (${browserMirror ? 'chunked browser' : 'node'})`, async t => {
  const classpath = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-class-replacement-'));
  const jvm = new JVM({classpath, jit: {compileWorker: true, warmupThreshold: 0}});
  const client = jvm.jit.compileWorker;
  if (browserMirror) {
    const createHost = client.createNodeWorkerHost.bind(client);
    client.createNodeWorkerHost = () => {
      const host = createHost();
      host.kind = 'web-worker';
      return host;
    };
  }
  t.teardown(() => {client.dispose(); fs.rmSync(classpath, {recursive: true, force: true});});
  const first = method('first', 14);
  jvm.classes.MirrorProbe = record([first]);
  jvm.classInitializationState.set('MirrorProbe', 'INITIALIZED');
  t.ok(client.enqueue(first, {}), 'initial class is queued');
  await client.whenIdle();
  t.ok(client.installedMethods.has(first), 'initial method installs');
  const added = method('added', 27);
  jvm.classes.MirrorProbe = record([first, added]);
  t.ok(client.enqueue(added, {}), 'newly available method is queued');
  await client.whenIdle();
  t.ok(client.installedMethods.has(added), 'replacement AST reaches the worker');
  t.equal(client.stats.refused, 0, 'new method is not permanently refused as missing');
  t.end();
});

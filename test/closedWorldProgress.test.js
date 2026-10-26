'use strict';
const test = require('node:test');
const {after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JVM} = require('../src/core/jvm');
const {compileFixture} = require('./helpers/closedWorld');
const directory = compileFixture('ClosedPreparationProgress');
after(() => fs.rmSync(directory, {recursive: true, force: true}));

async function fixture(observer = null) {
  const jvm = new JVM({classpath: directory, wasmHeap: true, wasmHeapMb: 1, closedWorld: true,
    jit: {compileWorker: false}, onPreparationProgress: observer});
  await jvm.loadClassByName('ClosedPreparationProgress');
  return {jvm, world: jvm.jit.closedWorld};
}

test('preparation reports real phases and counts without executing guest initializers', async () => {
  const events = [];
  const {jvm, world} = await fixture(event => {events.push(event); throw Error('observer failure');});
  const first = world.build(), concurrent = world.build();
  assert.equal(first, concurrent, 'concurrent requests share the one build');
  assert.equal(world.built, false);
  assert.equal(world.building, true);
  await first;
  assert.equal(world.built, true);
  assert.equal(world.building, false);
  for (const phase of ['class-load', 'closed-analysis', 'closed-compile', 'closed-module', 'closed-ready'])
    assert.ok(events.some(event => event.phase === phase), phase);
  for (const phase of ['closed-analysis', 'closed-compile']) {
    const values = events.filter(event => event.phase === phase);
    assert.ok(values.some(event => event.completed === 0));
    assert.ok(values.some(event => event.total > 0 && event.completed === event.total));
    assert.ok(values.every(event => event.completed >= 0 && event.completed <= event.total));
  }
  const fields = jvm.classes.ClosedPreparationProgress.staticFields;
  assert.equal(fields.get('initialized:I'), 0, 'preparation did not run clinit');
  await jvm.run('ClosedPreparationProgress');
  assert.equal(fields.get('initialized:I'), 12, 'guest initialization and main still execute once');
});

test('native module compilation is awaited while the host remains responsive', async () => {
  const {world} = await fixture();
  const original = WebAssembly.compile;
  let entered, release;
  const started = new Promise(resolve => {entered = resolve;});
  const gate = new Promise(resolve => {release = resolve;});
  try {
    WebAssembly.compile = bytes => {entered(); return gate.then(() => original(bytes));};
    const pending = world.build();
    await started;
    assert.equal(world.stats().built, false);
    assert.equal(world.stats().building, true);
    assert.equal(world.preparation.phase, 'closed-module');
    await new Promise(resolve => setImmediate(resolve));
    release();
    await pending;
    assert.equal(world.stats().built, true);
  } finally {release(); WebAssembly.compile = original;}
});

test('a failed build remains failed and never reports readiness', async () => {
  const events = [];
  const {world} = await fixture(event => events.push(event));
  const failure = new Error('analysis failed');
  world.analyze = () => {throw failure;};
  const pending = world.build();
  await assert.rejects(pending, error => error === failure);
  assert.equal(world.build(), pending);
  assert.equal(world.built, false);
  assert.equal(world.building, false);
  assert.equal(world.preparation.phase, 'closed-failed');
  assert.ok(!events.some(event => event.phase === 'closed-ready'));
});

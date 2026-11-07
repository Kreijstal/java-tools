'use strict';
// Save-state capture: a thread parked at a plain host call leaves the module
// with its full Java frame state and continues on the bytecode tiers. The
// fixture's output must match HotSpot however often that happens.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { compileFixture, hotspot, jspiNode } = require('./helpers/closedWorld');

const skip = jspiNode() ? false : 'no Node with WebAssembly.Suspending (set JVM_JSPI_NODE)';
const RUNNER = `
const { JVM } = require(process.env.CLOSED_JVM_PATH);
(async () => {
  const jvm = new JVM({ classpath: process.env.CLOSED_DIR, closedWorld: true, jit: { compileWorker: false } });
  let busy = false, captured = 0;
  const timer = setInterval(async () => {
    const world = jvm.jit.closedWorld;
    if (!world?.built || busy) return;
    busy = true;
    captured += (await world.captureThreads()).captured;
    busy = false;
  }, Number(process.env.CLOSED_EVERY));
  await jvm.run('ClosedCapture');
  clearInterval(timer);
  process.stderr.write('CAPTURED ' + captured + '\\n');
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
`;

for (const every of [1, 5, 37]) {
  test(`frames captured every ${every} ms finish exactly as on HotSpot`, { skip }, () => {
    const directory = compileFixture('ClosedCapture');
    const result = spawnSync(jspiNode(), ['-e', RUNNER], {
      encoding: 'utf8', timeout: 60000,
      env: { ...process.env, CLOSED_DIR: directory, CLOSED_EVERY: String(every), JVM_CLOSED_WORLD_SAVE_STATES: '1',
        CLOSED_JVM_PATH: path.join(__dirname, '..', 'src', 'core', 'jvm.js') },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, hotspot(directory, 'ClosedCapture'));
    const captured = Number(/CAPTURED (\d+)/.exec(result.stderr)?.[1]);
    assert.ok(captured > 0, `captured ${captured}`);
  });
}

// A snapshot rewinds the running JVM in place. Everything the fixture's result
// depends on (locals, stacks, object fields, arrays, statics, monitors) has to
// go back, or the rounds that run twice change the hash.
const REWIND = `
const { JVM } = require(process.env.CLOSED_JVM_PATH);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
  const jit = { compileWorker: false };
  if (process.env.CLOSED_SAVE_METHODS) jit.closedWorldSaveMethods = process.env.CLOSED_SAVE_METHODS.split(' ');
  const jvm = new JVM({ classpath: process.env.CLOSED_DIR, closedWorld: true, jit });
  const running = jvm.run(process.env.CLOSED_MAIN);
  while (!jvm.jit.closedWorld?.built) await pause(5);
  await pause(40);
  const snapshot = await jvm.takeLiveSnapshot({ timeoutMs: Number(process.env.CLOSED_SAVE_TIMEOUT || 30000) })
    .catch((error) => { process.stderr.write('REFUSED ' + error.message + '\\n'); return null; });
  if (!snapshot) { await running; process.exit(0); }
  process.stderr.write('LISTED ' + (jvm.jit.closedWorld.saveMethods?.size ?? -1) + ' SITES ' + jvm.jit.closedWorld.saveSites.length + '\\n');
  for (let i = 0; i < Number(process.env.CLOSED_REWINDS); i++) {
    await pause(60);
    await jvm.restoreLiveSnapshot(snapshot);
  }
  await running;
  process.stderr.write('LOOPS ' + (jvm.jit.closedWorld.counters.loopEntries || 0) + '\\n');
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
`;

for (const [main, rewinds] of [['ClosedCapture', 1], ['ClosedCapture', 3], ['ClosedRewind', 1], ['ClosedRewind', 3]]) {
  test(`${main} rewound ${rewinds} time(s) in place finishes exactly as on HotSpot`, { skip }, () => {
    const directory = compileFixture(main);
    const result = spawnSync(jspiNode(), ['-e', REWIND], {
      encoding: 'utf8', timeout: 60000,
      env: { ...process.env, CLOSED_DIR: directory, CLOSED_MAIN: main, CLOSED_REWINDS: String(rewinds), JVM_CLOSED_WORLD_SAVE_STATES: '1',
        CLOSED_JVM_PATH: path.join(__dirname, '..', 'src', 'core', 'jvm.js') },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, hotspot(directory, main));
  });
}

test('an extent allocated after a snapshot cannot free restored storage', () => {
  const { WasmHeap } = require('../src/core/wasmHeap');
  const heap = new WasmHeap(1);
  const kept = heap.alloc('[I', 16);
  const snapshot = heap.snapshot();
  const late = heap.alloc('[I', 16);
  const offset = late.byteOffset, record = { base: offset, bytes: 64, sequence: heap.extentSequence };
  heap.restore(snapshot);
  heap.reclaimExtent(record);
  assert.equal(heap.arrayBins.size, 0, 'a finalizer from the rewound timeline released nothing');
  const again = heap.alloc('[I', 16);
  assert.equal(again.byteOffset, offset, 'the restored allocator hands that address out again');
  assert.notEqual(kept.byteOffset, again.byteOffset);
  heap.reclaimExtent({ base: kept.byteOffset, bytes: 64, sequence: snapshot.extentSequence });
  assert.equal(heap.arrayBins.get(64)?.length, 1, 'a registration older than the snapshot still reclaims');
});

test('a restore leaves host presentation state alone', () => {
  const { Recorder, restoreRecord } = require('../src/core/liveSnapshot');
  // A frame was queued with the browser when the snapshot was taken...
  const component = { type: 'java/awt/Canvas', _pixels: [1], _presentScheduled: true, _presentToken: 4 };
  const recorder = new Recorder(null);
  recorder.visit(component);
  recorder.drain();
  // ...and has since been shown, so no callback is outstanding.
  component._presentScheduled = false;
  component._presentToken = 9;
  component._pixels = [2];
  restoreRecord(component, recorder.records.get(component));
  assert.equal(component._presentScheduled, false, 'a stale flag would swallow every later frame');
  assert.equal(component._presentToken, 9);
  assert.deepEqual(component._pixels, [1], 'guest state beside it still rewinds');
});

test('a snapshot from before the first frame keeps the upload buffer whole', () => {
  const { Recorder, restoreRecord } = require('../src/core/liveSnapshot');
  const component = { type: 'java/awt/Canvas', _pixels: [1] };
  const recorder = new Recorder(null);
  recorder.visit(component);
  recorder.drain();
  // The first frame creates the image and its 32-bit view together.
  const image = { width: 1, height: 1, data: new Uint8ClampedArray(4) };
  Object.assign(component, { _presentImageData: image, _presentPixels32: new Uint32Array(image.data.buffer) });
  restoreRecord(component, recorder.records.get(component));
  assert.equal(component._presentImageData, image);
  assert.ok(component._presentPixels32 instanceof Uint32Array, 'a lost view makes every later upload throw');
});

// A list names where saves may stop, and listed call sites prove the chain to
// each other at run time. Only the listed methods carry capture code.
const listed = (methods, extra = {}) => spawnSync(jspiNode(), ['-e', REWIND], {
  encoding: 'utf8', timeout: 60000,
  env: { ...process.env, CLOSED_DIR: compileFixture('ClosedRewind'), CLOSED_MAIN: 'ClosedRewind', CLOSED_REWINDS: '3',
    CLOSED_SAVE_METHODS: methods, JVM_CLOSED_WORLD_SAVE_STATES: '1', ...extra,
    CLOSED_JVM_PATH: path.join(__dirname, '..', 'src', 'core', 'jvm.js') },
});

test('a complete chain in the list captures and rewinds exactly', { skip }, () => {
  const result = listed('ClosedRewind.main([Ljava/lang/String;)V ClosedRewind.round(I)J');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, hotspot(compileFixture('ClosedRewind'), 'ClosedRewind'));
  const [, count, sites] = /LISTED (\d+) SITES (\d+)/.exec(result.stderr).map(Number);
  assert.equal(count, 3, 'round, main and main\'s loop entry');
  assert.ok(sites > 0 && sites < 120, `sites ${sites}`);
  assert.ok(Number(/LOOPS (\d+)/.exec(result.stderr)[1]) >= 3, 'each restore re-entered the module at the loop head');
});

test('a chain through an unlisted caller refuses the save and harms nothing', { skip }, () => {
  const result = listed('ClosedRewind.round(I)J', { CLOSED_SAVE_TIMEOUT: '60' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /REFUSED No safepoint/);
  assert.equal(result.stdout, hotspot(compileFixture('ClosedRewind'), 'ClosedRewind'));
});

test('a loop that never blocks still reaches a capture point', { skip }, () => {
  const directory = compileFixture('ClosedSpin');
  const result = spawnSync(jspiNode(), ['-e', REWIND], {
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, CLOSED_DIR: directory, CLOSED_MAIN: 'ClosedSpin', CLOSED_REWINDS: '2', CLOSED_SAVE_TIMEOUT: '5000',
      CLOSED_SAVE_METHODS: 'ClosedSpin.main([Ljava/lang/String;)V', JVM_CLOSED_WORLD_SAVE_STATES: '1',
      CLOSED_JVM_PATH: path.join(__dirname, '..', 'src', 'core', 'jvm.js') },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /REFUSED/);
  assert.match(result.stderr, /LISTED 2 SITES \d+/);
  assert.ok(Number(/LOOPS (\d+)/.exec(result.stderr)[1]) >= 2, 'the loop went back into the module');
  assert.equal(result.stdout, hotspot(directory, 'ClosedSpin'));
});

// A cached module has to save and load as well as the build that stored it,
// including the capture table and the loop entries a compile would have made.
const CACHED = `
const { JVM } = require(process.env.CLOSED_JVM_PATH);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const records = new Map(), write = process.stdout.write.bind(process.stdout);
const preparationCache = {
  async get(key) { return structuredClone(records.get(key)); },
  async put(entry) { const { module, ...kept } = entry; records.set(entry.key, structuredClone(kept)); },
  async delete(key) { records.delete(key); },
};
const start = () => {
  const jit = { compileWorker: false };
  if (process.env.CLOSED_SAVE_METHODS) jit.closedWorldSaveMethods = process.env.CLOSED_SAVE_METHODS.split(' ');
  const jvm = new JVM({ classpath: process.env.CLOSED_DIR, closedWorld: true, jit });
  Object.assign(jvm.jit.closedWorld, { cacheIdentity: 'fixture', preparationCache });
  return { jvm, world: jvm.jit.closedWorld, running: jvm.run(process.env.CLOSED_MAIN) };
};
(async () => {
  process.stdout.write = () => true;
  const cold = start();
  await cold.running;
  process.stdout.write = write;
  const { jvm, world, running } = start();
  while (!world.built) await pause(5);
  await pause(40);
  const snapshot = await jvm.takeLiveSnapshot({ timeoutMs: 5000 });
  for (let i = 0; i < 2; i++) {
    await pause(60);
    await jvm.restoreLiveSnapshot(snapshot);
  }
  await running;
  process.stderr.write(JSON.stringify({ cold: cold.world.stats().cache?.status, warm: world.stats().cache?.status,
    sites: world.saveSites.length, coldSites: cold.world.saveSites.length, loops: world.counters.loopEntries || 0 }) + '\\n');
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
`;

for (const [main, methods, loops] of [['ClosedRewind', '', false], ['ClosedSpin', 'ClosedSpin.main([Ljava/lang/String;)V', true]]) {
  test(`${main} saves and rewinds from a cached module${methods ? ' with a list' : ''}`, { skip }, () => {
    const directory = compileFixture(main);
    const result = spawnSync(jspiNode(), ['-e', CACHED], {
      encoding: 'utf8', timeout: 90000,
      env: { ...process.env, CLOSED_DIR: directory, CLOSED_MAIN: main, CLOSED_SAVE_METHODS: methods, JVM_CLOSED_WORLD_SAVE_STATES: '1',
        CLOSED_JVM_PATH: path.join(__dirname, '..', 'src', 'core', 'jvm.js') },
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stderr.trim().split('\n').at(-1));
    assert.equal(report.cold, 'stored', result.stderr);
    assert.equal(report.warm, 'hit', result.stderr);
    assert.equal(report.sites, report.coldSites);
    assert.ok(report.sites > 0);
    if (loops) assert.ok(report.loops >= 2, 'restores re-entered the cached module at the loop head');
    assert.equal(result.stdout, hotspot(directory, main));
  });
}

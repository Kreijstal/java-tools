'use strict';
const test = require('tape');
const grow = require('../src/io/growByteView');

test('cached byte appends preserve data with bounded spare capacity and copying', t => {
  let view = new Uint8Array(), copied = 0, allocations = 0;
  for (let i = 0; i < 10000; i++) {
    const old = view;
    view = grow(view, old.length + 512);
    if (view.buffer !== old.buffer) { copied += old.length; allocations++; }
    view.fill(i & 255, old.length);
  }
  t.equal(view.length, 5120000, 'logical file length is exact');
  t.ok(view.buffer.byteLength - view.length <= 1024 * 1024, 'spare capacity remains bounded');
  t.ok(allocations < 30, 'small appends do not each allocate a whole file');
  t.ok(copied < view.length * 8, 'copied bytes remain far below quadratic growth');
  let correct = true;
  for (let i = 0; i < view.length; i++) if (view[i] !== ((i >>> 9) & 255)) { correct = false; break; }
  t.ok(correct, 'every appended byte survives growth');
  const extended = grow(view, view.length + 17);
  t.deepEqual([...extended.subarray(view.length)], Array(17).fill(0), 'new bytes are zero initialized');
  t.end();
});

test('unsupported buffer forms retain dependency handling', t => {
  t.equal(grow(new Uint16Array(8), 32), null, 'other element sizes use the original implementation');
  t.equal(grow(Buffer.alloc(8), 32), null, 'Buffer subclasses retain their constructor and methods');
  t.equal(grow(new Uint8Array(8).subarray(1), 12), null, 'offset views use original handling');
  t.equal(grow(new Uint8Array(8), 8), null, 'no-growth requests use original handling');
  t.equal(grow(new Uint8Array(8), -1), null, 'invalid sizes use original validation');
  t.end();
});

test('bundle integration preserves real sparse cache merges and overwrites', async t => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const {pathToFileURL} = require('node:url');
  const transform = require('../config/growing-buffer-loader');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jvm-buffer-cache-'));
  t.teardown(() => fs.rmSync(dir, {recursive: true, force: true}));
  const original = fs.readFileSync(require.resolve('utilium/buffer'), 'utf8');
  fs.writeFileSync(path.join(dir, 'buffer.mjs'), transform(original));
  fs.writeFileSync(path.join(dir, 'cache.mjs'),
    fs.readFileSync(require.resolve('utilium/cache'), 'utf8').replace("'./buffer.js'", "'./buffer.mjs'"));
  const {Resource} = await import(pathToFileURL(path.join(dir, 'cache.mjs')).href);
  const resource = new Resource('fixture', 0, {sparse: true});
  for (let i = 0; i < 4096; i++) resource.add(Uint8Array.of(i & 255), i);
  t.equal(resource.regions.length, 1, 'adjacent writes still merge');
  t.equal(resource.regions[0].data.length, 4096, 'merge retains exact visible length');
  t.ok(resource.regions[0].data.buffer.byteLength > 4096, 'real cache uses retained growth capacity');
  resource.add(Uint8Array.of(7, 8), 100);
  t.deepEqual([...resource.regions[0].data.subarray(99, 103)], [99, 7, 8, 102], 'overlap updates only the written range');
  resource.add(Uint8Array.of(42), 4100);
  t.deepEqual(resource.missing(4096, 4101), [{start: 4096, end: 4100}], 'spare backing capacity does not mark unwritten gaps present');
  t.throws(() => transform('export function changed() {}'), /review browser buffer growth/,
    'dependency changes fail the build for review');
  t.end();
});

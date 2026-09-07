'use strict';

// Size-class free lists for object slabs (docs/refactor.md 2.2, "the first
// allocation foundation"). These test the allocator only. Nothing here decides
// which guest objects are dead -- that is the separate liveness half of
// Phase 2, and free() deliberately has no caller in the runtime yet.

const test = require('tape');
const { WasmHeap } = require('../src/core/wasmHeap');

test('a freed slab is handed back to the next same-size request', (t) => {
  const heap = new WasmHeap(1);
  const first = heap.allocObject(32);
  t.ok(first > 0, 'allocated');
  t.equal(heap.usage().bumped, 1, 'came from the bump pointer');

  t.ok(heap.free(first, 32), 'freed');
  const second = heap.allocObject(32);
  t.equal(second, first, 'the same extent is reused');
  t.equal(heap.usage().reused, 1, 'counted as a reuse, not a bump');
  t.equal(heap.usage().bumped, 1, 'the bump pointer did not move again');
  t.end();
});

test('a recycled slab reads as zero', (t) => {
  // The bump path can return untouched memory because fresh wasm memory is
  // already zeroed, and callers depend on that. Reuse has to restore the
  // invariant by hand; if it does not, a new object silently inherits the
  // previous object's field values.
  const heap = new WasmHeap(1);
  const base = heap.allocObject(32);
  for (let i = 0; i < 8; i += 1) heap.i32[(base >> 2) + i] = 0x5eeded;

  heap.free(base, 32);
  const reused = heap.allocObject(32);
  t.equal(reused, base, 'same extent, so this is the interesting case');
  for (let i = 0; i < 8; i += 1) {
    t.equal(heap.i32[(base >> 2) + i], 0, `word ${i} was cleared`);
  }
  t.end();
});

test('sizes are binned exactly, so a bin never serves a larger request', (t) => {
  const heap = new WasmHeap(1);
  const small = heap.allocObject(16);
  heap.free(small, 16);

  const larger = heap.allocObject(64);
  t.notEqual(larger, small, 'a 64-byte request did not take the 16-byte slab');
  t.equal(heap.usage().reused, 0, 'no reuse happened');
  t.end();
});

test('rounding is consistent between alloc and free', (t) => {
  // 20 bytes rounds to 24. If free() rounded differently the extent would land
  // in a bin no allocation ever asks for, and the memory would leak silently.
  const heap = new WasmHeap(1);
  const base = heap.allocObject(20);
  t.ok(heap.free(base, 20), 'freed at the unrounded size');
  t.equal(heap.allocObject(24), base, 'a 24-byte request reuses it');
  t.end();
});

test('oversized extents are reported as not recycled rather than dropped silently', (t) => {
  const heap = new WasmHeap(1);
  const base = heap.allocObject(8192);
  t.equal(heap.free(base, 8192), false, 'free() says it did not bin the extent');
  t.equal(heap.usage().freed, 0, 'and does not count it as reclaimed');
  t.end();
});

test('free() rejects a null address', (t) => {
  const heap = new WasmHeap(1);
  t.equal(heap.free(0, 32), false, 'address 0 encodes null and is never a slab');
  t.end();
});

test('reuse bounds the heap under repeated alloc/free', (t) => {
  // The recorded failure mode is ~1.5 MB/min of menu growth from a bump
  // allocator that never frees. This is the allocator-level version of the
  // property that has to hold before any collector can matter.
  const heap = new WasmHeap(1);
  let base = heap.allocObject(48);
  const firstTop = heap.usage().allocated;
  for (let i = 0; i < 10000; i += 1) {
    heap.free(base, 48);
    base = heap.allocObject(48);
  }
  t.equal(heap.usage().allocated, firstTop, 'the bump pointer never advanced');
  t.equal(heap.usage().bumped, 1, 'one bump, ten thousand reuses');
  t.equal(heap.usage().reused, 10000, 'every later request was served free');
  t.end();
});

test('usage() separates parked bytes from live bytes', (t) => {
  const heap = new WasmHeap(1);
  const a = heap.allocObject(32);
  heap.allocObject(32);
  t.equal(heap.usage().allocated, 64, 'both slabs came from the bump pointer');
  t.equal(heap.usage().free, 0, 'nothing parked yet');
  t.equal(heap.usage().live, 64, 'so live equals allocated');

  heap.free(a, 32);
  t.equal(heap.usage().allocated, 64, 'freeing does not rewind the bump pointer');
  t.equal(heap.usage().free, 32, 'the extent is parked in its bin');
  t.equal(heap.usage().live, 32, 'and no longer counted live');
  t.end();
});

test('exhaustion still degrades rather than failing', (t) => {
  const heap = new WasmHeap(1);
  let last = 0;
  for (let i = 0; i < 100000; i += 1) {
    last = heap.allocObject(1024);
    if (last < 0) break;
  }
  t.equal(last, -1, 'a spent heap returns -1 so callers fall back to a plain map');
  t.ok(heap.exhausted, 'and records that it happened');
  t.end();
});

// --- array extents -------------------------------------------------------
// Measurement (dekobloko-work/docs/phase2-representation.md section 6) put the
// entire ~5.8 MB/min stable-menu growth in alloc(), not in object slabs: all
// 86 MB of a five-minute session is primitive arrays. These cover the free
// list for the allocator that actually leaks.

test('a freed array extent is reused by the next same-size array', (t) => {
  const heap = new WasmHeap(1);
  const first = heap.alloc('[I', 64);
  t.equal(typeof first.wasmBase, 'number', 'came from the heap');

  t.ok(heap.freeArray(first), 'freed');
  const second = heap.alloc('[I', 64);
  t.equal(second.wasmBase, first.wasmBase, 'same extent reused');
  t.equal(heap.usage().arrayReused, 1, 'counted as a reuse');
  t.equal(heap.usage().arrayBumped, 1, 'the bump pointer did not move again');
  t.end();
});

test('a recycled array reads as zero', (t) => {
  const heap = new WasmHeap(1);
  const first = heap.alloc('[I', 16);
  first.fill(0x5eeded);
  heap.freeArray(first);

  const second = heap.alloc('[I', 16);
  t.equal(second.wasmBase, first.wasmBase, 'same extent, the interesting case');
  t.equal(second.every((v) => v === 0), true, 'every element was cleared');
  t.end();
});

test('a recycled long array reads as zero, not as stale bigints', (t) => {
  // BigInt64Array needs 0n, not 0. Filling it with a Number throws, so a
  // careless clear would break the long-array path specifically.
  const heap = new WasmHeap(1);
  const first = heap.alloc('[J', 8);
  first.fill(123n);
  heap.freeArray(first);

  const second = heap.alloc('[J', 8);
  t.equal(second.wasmBase, first.wasmBase, 'same extent');
  t.equal(second.every((v) => v === 0n), true, 'cleared to 0n');
  t.end();
});

test('extents are interchangeable across element types of equal byte size', (t) => {
  // Bins are keyed by exact byte size and alignment is checked when an extent
  // is popped, so a byte[] extent that happens to be well enough aligned can
  // still serve an int[] of the same size. Reuse is opportunistic here rather
  // than guaranteed, which is the deliberate trade: guaranteeing it required
  // rounding every extent to 8 bytes, and that cost more in padding on the
  // menu's ~446k arrays/minute than cross-type reuse could return.
  const heap = new WasmHeap(1);
  const bytes = heap.alloc('[B', 64);
  const base = bytes.wasmBase;
  heap.freeArray(bytes);

  const ints = heap.alloc('[I', 16);
  t.equal(ints.wasmBase, base, 'the int array took the byte array’s extent');
  t.end();
});

test('freeArray refuses an array the heap did not hand out', (t) => {
  const heap = new WasmHeap(1);
  t.equal(heap.freeArray(new Int32Array(8)), false, 'a plain fallback array');
  t.equal(heap.freeArray(null), false, 'null');
  t.equal(heap.usage().arrayFreed, 0, 'neither was counted');
  t.end();
});

test('array reuse bounds the heap under repeated alloc/free', (t) => {
  const heap = new WasmHeap(1);
  let view = heap.alloc('[I', 128);
  const afterFirst = heap.usage().allocated;
  for (let i = 0; i < 5000; i += 1) {
    heap.freeArray(view);
    view = heap.alloc('[I', 128);
  }
  t.equal(heap.usage().allocated, afterFirst, 'the bump pointer never advanced');
  t.equal(heap.usage().arrayBumped, 1, 'one bump, five thousand reuses');
  t.equal(heap.usage().arrayReused, 5000, 'every later request was served free');
  t.end();
});

test('usage() counts array free bytes as not live', (t) => {
  const heap = new WasmHeap(1);
  const view = heap.alloc('[I', 32); // 128 bytes
  t.equal(heap.usage().allocated, 128, 'bumped 128 bytes');
  t.equal(heap.usage().live, 128, 'all live');

  heap.freeArray(view);
  t.equal(heap.usage().allocated, 128, 'freeing does not rewind the bump pointer');
  t.equal(heap.usage().free, 128, 'parked in its bin');
  t.equal(heap.usage().live, 0, 'and no longer live');
  t.end();
});

test('a non-primitive descriptor is still refused', (t) => {
  const heap = new WasmHeap(1);
  t.equal(heap.alloc('[Ljava/lang/String;', 4), null, 'reference arrays are not heap arrays yet');
  t.end();
});

test('array extents are sized exactly, not rounded up', (t) => {
  // The regression this pins: rounding every extent to 8 bytes raised measured
  // stable-menu heap growth from 5.83 to 6.86 MB/min, because the menu's
  // arrays average 16.1 bytes and paid the padding on every one of them.
  const heap = new WasmHeap(1);
  const before = heap.usage().allocated;
  heap.alloc('[B', 20);
  t.equal(heap.usage().allocated - before, 20, 'a byte[20] costs 20 bytes');

  const beforeSecond = heap.usage().allocated;
  heap.alloc('[B', 3);
  t.equal(heap.usage().allocated - beforeSecond, 3, 'a byte[3] costs 3 bytes');
  t.end();
});

test('a misaligned extent is not handed to a wider element type', (t) => {
  // byte[] needs no alignment, so a byte[] extent can start at an odd address.
  // An Int32Array view over an odd base would throw, so the bin must refuse it
  // and bump instead.
  const heap = new WasmHeap(1);
  heap.alloc('[B', 1);            // leaves the bump pointer odd
  const odd = heap.alloc('[B', 8);
  t.equal(odd.wasmBase % 4 !== 0, true, 'the extent really is misaligned');
  heap.freeArray(odd);

  const ints = heap.alloc('[I', 2); // 8 bytes, needs a 4-aligned base
  t.equal(ints.wasmBase % 4, 0, 'the int array got an aligned base');
  t.equal(ints.wasmBase !== odd.wasmBase, true, 'not the misaligned extent');
  t.equal(heap.usage().arrayReused, 0, 'nothing was reused');
  t.end();
});

test('an extent larger than the bin ceiling is not recycled', (t) => {
  const heap = new WasmHeap(1);
  const big = heap.alloc('[B', 8192);
  t.equal(heap.freeArray(big), false, 'refused: above MAX_BINNED_BYTES');
  t.equal(heap.usage().arrayFreed, 0, 'not counted as freed');
  t.end();
});

// --- Design A reclamation: wrapper death returns the extent -----------------

test('a dead view returns its extent to the free list', async (t) => {
  if (typeof global.gc !== 'function') {
    t.skip('needs --expose-gc');
    t.end();
    return;
  }
  const heap = new WasmHeap(1);
  let view = heap.alloc('[I', 16);
  const base = view.wasmBase;
  const bumped = heap.usage().arrayBumped;
  view = null;

  global.gc();
  // Finalization callbacks run on a later job, not synchronously after gc().
  for (let i = 0; i < 10 && heap.usage().arrayReclaimed === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    global.gc();
  }
  t.equal(heap.usage().arrayReclaimed, 1, 'the extent was reclaimed');

  const next = heap.alloc('[I', 16);
  t.equal(next.wasmBase, base, 'the reclaimed extent was handed out again');
  t.equal(heap.usage().arrayBumped, bumped, 'the bump pointer did not advance');
  t.end();
});

test('an explicitly freed extent is not reclaimed twice', (t) => {
  // freeArray bins the extent while the view is still alive. Without the
  // unregister, the view's later death would bin the same base a second time
  // and the allocator would hand one extent to two arrays.
  const heap = new WasmHeap(1);
  const view = heap.alloc('[I', 16);
  t.equal(heap.freeArray(view), true, 'freed explicitly');
  const bin = heap.arrayBins.get(view.byteLength) || [];
  t.equal(bin.length, 1, 'binned exactly once');
  heap.reclaimExtent({ base: view.wasmBase, bytes: view.byteLength });
  t.equal((heap.arrayBins.get(view.byteLength) || []).length, 2,
    'reclaimExtent is unguarded on its own; the unregister is what prevents this');
  t.end();
});

test('reclamation is off when the flag says so', (t) => {
  const saved = process.env.JVM_WASM_HEAP_RECLAIM;
  process.env.JVM_WASM_HEAP_RECLAIM = '0';
  t.teardown(() => {
    if (saved === undefined) delete process.env.JVM_WASM_HEAP_RECLAIM;
    else process.env.JVM_WASM_HEAP_RECLAIM = saved;
  });
  const heap = new WasmHeap(1);
  t.equal(heap.registry, null, 'no registry, so no reclamation overhead');
  const view = heap.alloc('[I', 16);
  t.equal(typeof view.wasmBase, 'number', 'allocation still works');
  t.end();
});

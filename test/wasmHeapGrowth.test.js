'use strict';

// docs/refactor.md 2.3 ("Memory growth and cached views"). Two requirements
// are tested separately here, deliberately: the section is explicit that
// "growing a memory and moving an object are different events. Code must not
// mistake a refreshed view for proof that all object references were updated."

const test = require('tape');
const { WasmHeap } = require('../src/core/wasmHeap');

// The fact the whole guard rests on. Pinned as a test so that a future change
// that "just enables growth" fails here rather than in the guest, where a
// zero-length int[] would surface far from its cause.
test('WebAssembly.Memory.grow detaches existing views silently', (t) => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 4 });
  const view = new Int32Array(memory.buffer, 0, 4);
  view[0] = 0x5eed;
  t.equal(view[0], 0x5eed, 'the view reads back before growth');
  memory.grow(1);
  t.equal(view.length, 0, 'growth leaves the old view zero-length');
  t.equal(view[0], undefined, 'and reading it returns undefined rather than throwing');
  t.end();
});

test('the default heap reserves instead of growing', (t) => {
  const heap = new WasmHeap(1);
  const usage = heap.usage();
  t.equal(usage.limit, usage.reserved, 'initial capacity is the whole reservation');
  t.equal(heap.growBlocker(), 'at reserved maximum',
    'so there is nothing to grow into');
  t.equal(heap.growTo(2 * 1024 * 1024), false, 'and growTo refuses');
  t.equal(heap.usage().grows, 0, 'without growing');
  t.end();
});

test('refreshViews is the single hook and advances the epoch', (t) => {
  const heap = new WasmHeap(2, 1);
  const before = heap.viewEpoch;
  const i32 = heap.i32;
  const epoch = heap.refreshViews();
  t.equal(epoch, before + 1, 'the epoch advances');
  t.notEqual(heap.i32, i32, 'the i32 view is re-derived');
  t.equal(heap.i32.buffer, heap.memory.buffer, 'i32 covers the current buffer');
  t.equal(heap.f64.buffer, heap.memory.buffer, 'f64 covers the current buffer');
  t.equal(heap.i64.buffer, heap.memory.buffer, 'i64 covers the current buffer');
  t.end();
});

test('growth preserves slab contents and does not move objects', (t) => {
  const heap = new WasmHeap(2, 1);
  const base = heap.allocObject(32);
  t.ok(base > 0, 'a slab was allocated');
  heap.i32[(base >> 2) + 1] = 0x1234;
  const epoch = heap.viewEpoch;

  t.equal(heap.growBlocker(), null, 'growth is sound with no guest array views');
  t.equal(heap.growTo(1024 * 1024 + 65536), true, 'the heap grew');
  t.ok(heap.viewEpoch > epoch, 'the view epoch advanced');
  t.ok(heap.limit > 1024 * 1024, 'capacity increased');

  // Growth is not relocation. The section requires these be distinguishable,
  // so assert the object did not move and its bytes survived.
  t.equal(heap.i32[(base >> 2) + 1], 0x1234,
    'the slab still reads through the refreshed view');
  t.equal(heap.allocObject(32) > base, true,
    'the bump pointer continued rather than restarting');
  t.end();
});

test('growth is refused while a guest array view is outstanding', (t) => {
  const heap = new WasmHeap(2, 1);
  const array = heap.alloc('[I', 8);
  t.equal(typeof array.wasmBase, 'number', 'the array is heap-backed');
  array[3] = 99;

  const blocker = heap.growBlocker();
  t.ok(blocker && /detach/.test(blocker),
    `growth names the detaching views (${blocker})`);
  t.equal(heap.growTo(1024 * 1024 + 65536), false, 'growTo refuses');
  t.equal(heap.usage().grows, 0, 'nothing grew');
  t.equal(array[3], 99, 'and the guest array is intact');
  t.equal(heap.lastGrowRefusal, blocker, 'the refusal reason is recorded');
  t.end();
});

test('a freed array view stops blocking growth', (t) => {
  const heap = new WasmHeap(2, 1);
  const array = heap.alloc('[I', 8);
  t.equal(heap.usage().arrayViewsLive, 1, 'one live view');
  t.ok(heap.freeArray(array), 'the extent was returned explicitly');
  t.equal(heap.usage().arrayViewsLive, 0, 'the live count fell back to zero');
  t.equal(heap.growBlocker(), null, 'growth is sound again');
  t.equal(heap.growTo(1024 * 1024 + 65536), true, 'and it grows');
  t.end();
});

test('exhausted object allocation grows instead of failing', (t) => {
  // One megabyte of capacity, two reserved: fill the first and the next
  // allocation must come back from a grown heap rather than as -1.
  const heap = new WasmHeap(2, 1);
  let last = 0;
  for (let i = 0; i < 300; i += 1) last = heap.allocObject(4096);
  t.ok(last > 0, 'allocation past the initial page succeeded');
  t.ok(heap.usage().grows > 0, 'because the heap grew');
  t.equal(heap.exhausted, false, 'and it never declared itself exhausted');
  t.end();
});

test('growth is refused when array liveness is untracked', (t) => {
  const heap = new WasmHeap(2, 1);
  heap.registry = null; // as if FinalizationRegistry were unavailable
  const array = heap.alloc('[I', 4);
  t.equal(typeof array.wasmBase, 'number', 'the array is heap-backed');
  heap.arrayViewsLive = 0; // pretend the count went stale
  t.ok(/untracked/.test(heap.growBlocker() || ''),
    'an untrusted live count blocks growth on its own');
  t.end();
});

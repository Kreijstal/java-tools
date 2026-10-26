'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {WasmHeap} = require('../src/core/wasmHeap');

function fullHeap() {
  const heap = new WasmHeap(0.0625);
  const arrays = [];
  while (heap.limit - heap.top >= 1024) arrays.push(heap.alloc('[B', 1024));
  heap.allocExtent('[B', heap.limit - heap.top);
  return {heap, arrays};
}

test('pressure combines adjacent dead arrays while retaining live neighbours', () => {
  const {heap, arrays} = fullHeap();
  arrays[0].fill(91); arrays[4].fill(37);
  for (const i of [2, 0, 3, 1]) assert.equal(heap.freeArray(arrays[i]), true);
  const combined = heap.alloc('[I', 1024);
  assert.equal(combined.wasmBase, arrays[0].wasmBase);
  assert.ok(combined.every(value => value === 0));
  assert.ok(arrays[4].every(value => value === 37));
  assert.equal(heap.usage().free, 0);
  assert.equal(heap.usage().limit, 65536);
});

test('pressure splits a dead array for objects and arrays with exact accounting', () => {
  const {heap, arrays} = fullHeap();
  assert.equal(heap.freeArray(arrays[0]), true);
  const object = heap.allocObject(24);
  assert.equal(object, arrays[0].wasmBase);
  const array = heap.alloc('[I', 250);
  assert.equal(array.wasmBase, object + 24);
  assert.equal(heap.usage().free, 0);
  assert.equal(heap.free(object, 24), true);
  const smaller = heap.alloc('[J', 2);
  assert.equal(smaller.wasmBase, object);
  assert.deepEqual(Array.from(smaller), [0n, 0n]);
  assert.equal(heap.usage().free, 8);
  assert.ok(heap.allocExtent('[B', 8) > 0);
  assert.equal(heap.usage().free, 0);
});

test('later reclamation recovers native allocation after a genuine exhaustion', () => {
  const {heap, arrays} = fullHeap();
  assert.equal(heap.alloc('[I', 128).wasmBase, undefined);
  assert.equal(heap.freeArray(arrays[10]), true);
  const recovered = heap.alloc('[I', 128);
  assert.equal(recovered.wasmBase, arrays[10].wasmBase);
  assert.equal(heap.usage().free, 512);
  assert.equal(heap.usage().live + heap.usage().free, heap.usage().allocated);
});

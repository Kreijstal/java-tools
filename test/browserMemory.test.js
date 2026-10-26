'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const MiB = 1048576;
const source = fs.readFileSync(path.join(__dirname, '../src/core/browserMemory.js'), 'utf8');
const options = {wasmHeapMaxMb: 384, wasmHeapBudgetMb: 512, wasmHeapHeadroomMb: 96};
function fresh(extra = {}) {
  const context = vm.createContext({module: {exports: {}}, ...extra});
  vm.runInContext(source, context);
  return context.module.exports;
}
const host = (usedMb, deviceMemory) => ({performance: {memory: {
  usedJSHeapSize: usedMb * MiB, totalJSHeapSize: (usedMb + 16) * MiB, jsHeapSizeLimit: 1024 * MiB}},
  navigator: {deviceMemory}});
const heap = (allocated, capacity) => ({usage: () => ({allocated, reserved: capacity}), memory: {buffer: {byteLength: capacity}}});

test('accounts known linear storage separately from approximate Chromium heap bytes', () => {
  const memory = fresh();
  const first = heap(32 * MiB, 256 * MiB), other = heap(4 * MiB, 128 * MiB);
  memory.trackHeap(first); memory.trackHeap(other);
  const snapshot = memory.captureMemoryUsage(first, host(100));
  assert.equal(snapshot.source, 'performance.memory');
  assert.equal(snapshot.jsHeapUsedBytes, 100 * MiB);
  assert.equal(snapshot.linearAllocatedBytes, 36 * MiB);
  assert.equal(snapshot.linearCapacityBytes, 384 * MiB);
  assert.equal(snapshot.estimatedUsedBytes, 136 * MiB);
  assert.equal(snapshot.knownHeaps, 2);
  assert.equal(snapshot.apiMayBeCached, true);
  assert.equal(snapshot.workersIncluded, false);
});

test('startup expansion stays within the configured estimate and headroom', () => {
  const memory = fresh();
  const other = heap(16 * MiB, 128 * MiB); memory.trackHeap(other);
  for (const [used, expected] of [[16, 384], [48, 352], [100, 288], [160, 256], [500, 256]]) {
    const decision = memory.selectWasmHeapSize(256, options, host(used, 8));
    assert.equal(decision.selectedMb, expected);
    assert.equal(decision.reason, expected > 256 ? 'estimated-headroom' : 'budget-headroom');
    if (expected > 256) assert.ok((used + 16 + expected + 96) * MiB <= options.wasmHeapBudgetMb * MiB);
  }
});

test('unconfigured, constrained or unavailable estimates preserve the base heap', () => {
  const memory = fresh();
  const unread = {get performance() {throw Error('fixed policies must not read the API');}};
  assert.equal(memory.selectWasmHeapSize(256, {}, unread).reason, 'fixed');
  for (const device of [0.5, 1, 2]) assert.equal(memory.selectWasmHeapSize(256, options, host(16, device)).reason, 'small-device');
  for (const value of [{}, {get performance() {throw Error('blocked');}}, host(NaN), host(-1)]) {
    assert.equal(memory.selectWasmHeapSize(256, options, value).selectedMb, 256);
    assert.equal(memory.selectWasmHeapSize(256, options, value).reason, 'no-memory-estimate');
  }
  const limited = host(32); limited.performance.memory.jsHeapSizeLimit = 256 * MiB;
  assert.equal(memory.selectWasmHeapSize(256, options, limited).selectedMb, 256);
  for (const invalid of [{wasmHeapMaxMb: Infinity}, {wasmHeapBudgetMb: -1}, {wasmHeapHeadroomMb: NaN}])
    assert.equal(memory.selectWasmHeapSize(256, {...options, ...invalid}, host(16)).reason, 'invalid-policy');
});

test('missing weak heap accounting prevents expansion and marks partial coverage', () => {
  const memory = fresh({WeakRef: undefined, FinalizationRegistry: undefined});
  const current = heap(20, 100); memory.trackHeap(current);
  const snapshot = memory.captureMemoryUsage(current, host(16));
  assert.equal(snapshot.linearAllocatedBytes, 20);
  assert.equal(snapshot.linearCoverage, 'current-heap');
  assert.equal(memory.selectWasmHeapSize(256, options, host(16)).reason, 'no-memory-estimate');
});

test('memory accounting does not retain a discarded heap', {skip: !global.gc}, async () => {
  const memory = fresh();
  let discarded = heap(1024, 4096);
  memory.trackHeap(discarded);
  assert.equal(memory.captureMemoryUsage(null, host(1)).knownHeaps, 1);
  discarded = null;
  for (let i = 0; i < 40; i++) {
    await new Promise(setImmediate); global.gc(); await new Promise(setImmediate);
    if (memory.captureMemoryUsage(null, host(1)).knownHeaps === 0) break;
  }
  assert.equal(memory.captureMemoryUsage(null, host(1)).knownHeaps, 0);
  assert.equal(memory.captureMemoryUsage(null, host(1)).linearAllocatedBytes, 0);
});

test('JVM chooses the capacity before views exist and falls back if expansion is refused', () => {
  const {JVM} = require('../src/core/jvm');
  const descriptor = Object.getOwnPropertyDescriptor(performance, 'memory');
  const originalMemory = WebAssembly.Memory;
  try {
    Object.defineProperty(performance, 'memory', {value: host(1).performance.memory, configurable: true});
    const smallOptions = {wasmHeap: true, wasmHeapMb: 0.0625, wasmHeapMaxMb: 0.25,
      wasmHeapBudgetMb: 512, wasmHeapHeadroomMb: 96, jit: {enabled: false}};
    const expanded = new JVM(smallOptions);
    assert.equal(expanded.wasmHeap.limit, 0.25 * MiB);
    const view = expanded.wasmHeap.alloc('[I', 4); view[0] = 123;
    assert.equal(expanded.getMemoryUsage().allocationPolicy.reason, 'estimated-headroom');
    assert.equal(view[0], 123);
    const attempts = [];
    WebAssembly.Memory = function (options) {
      attempts.push(options.initial);
      if (options.initial > 1) throw new RangeError('reservation refused');
      return new originalMemory(options);
    };
    const fallback = new JVM(smallOptions);
    assert.deepEqual(attempts, [4, 1]);
    assert.equal(fallback.wasmHeap.limit, 65536);
    assert.equal(fallback.wasmHeapAllocationPolicy.reason, 'allocation-refused');
    assert.equal(view[0], 123, 'another VM allocation never detaches an existing view');
  } finally {
    WebAssembly.Memory = originalMemory;
    if (descriptor) Object.defineProperty(performance, 'memory', descriptor);
    else delete performance.memory;
  }
});

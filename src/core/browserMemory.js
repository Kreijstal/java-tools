'use strict';

const MiB = 1048576;
const heaps = new Set();
const tracksHeaps = typeof WeakRef === 'function' && typeof FinalizationRegistry === 'function';
const finalizers = tracksHeaps ? new FinalizationRegistry(reference => heaps.delete(reference)) : null;

// Neither the accounting set nor its finalizer holdings retain a VM/heap.
function trackHeap(heap) {
  if (!tracksHeaps) return;
  const reference = new WeakRef(heap);
  heaps.add(reference);
  finalizers.register(heap, reference);
}

function captureMemoryUsage(currentHeap = null, host = globalThis) {
  let js = null, deviceMemoryGiB = null;
  try {
    const memory = host.performance?.memory;
    if (memory) {
      const used = memory.usedJSHeapSize, total = memory.totalJSHeapSize, limit = memory.jsHeapSizeLimit;
      if ([used, total, limit].every(value => Number.isFinite(value) && value >= 0)
          && total >= used && limit > 0) js = {used, total, limit};
    }
    const device = host.navigator?.deviceMemory;
    if (Number.isFinite(device) && device > 0) deviceMemoryGiB = device;
  } catch (_) { /* Optional browser estimates must never break execution. */ }
  let linearAllocatedBytes = 0, linearCapacityBytes = 0, linearReservedBytes = 0, knownHeaps = 0;
  const count = heap => {
    const usage = heap.usage();
    linearAllocatedBytes += usage.allocated;
    linearCapacityBytes += heap.memory.buffer.byteLength;
    linearReservedBytes += usage.reserved;
    knownHeaps++;
  };
  if (tracksHeaps) {
    for (const reference of heaps) {
      const heap = reference.deref();
      if (heap) count(heap);
      else heaps.delete(reference);
    }
  } else if (currentHeap) count(currentHeap);
  return {source: js ? 'performance.memory' : 'unavailable', approximate: true,
    apiMayBeCached: Boolean(js), workersIncluded: false,
    linearCoverage: tracksHeaps ? 'known-context-heaps' : 'current-heap', knownHeaps,
    jsHeapUsedBytes: js?.used ?? null, jsHeapTotalBytes: js?.total ?? null,
    jsHeapLimitBytes: js?.limit ?? null, deviceMemoryGiB,
    linearAllocatedBytes, linearCapacityBytes, linearReservedBytes,
    // Conservative accounting estimate, not process RSS. Some engines may
    // already include part of linear storage in their heap estimate.
    estimatedUsedBytes: js ? js.used + linearAllocatedBytes : null};
}

function selectWasmHeapSize(baseMb, options, host = globalThis) {
  const maxMb = options.wasmHeapMaxMb, budgetMb = options.wasmHeapBudgetMb;
  const headroomMb = options.wasmHeapHeadroomMb ?? 96;
  const fixed = reason => ({selectedMb: baseMb, baseMb, reason});
  // Do not prime Chromium's possibly cached counter during an earlier,
  // unconfigured compiler/debug VM construction.
  if (maxMb === undefined || budgetMb === undefined) return fixed('fixed');
  if (![baseMb, maxMb, budgetMb].every(value => Number.isFinite(value) && value > 0)
      || !Number.isFinite(headroomMb) || headroomMb < 0) return fixed('invalid-policy');
  if (maxMb <= baseMb) return fixed('configured-limit');
  const memory = captureMemoryUsage(null, host);
  const decision = {selectedMb: baseMb, baseMb, maxMb, budgetMb, headroomMb,
    estimatedExistingBytes: memory.estimatedUsedBytes, approximate: true};
  if (memory.estimatedUsedBytes === null || !tracksHeaps) return {...decision, reason: 'no-memory-estimate'};
  if (memory.deviceMemoryGiB !== null && memory.deviceMemoryGiB <= 2) return {...decision, reason: 'small-device'};
  const budgetBytes = Math.min(budgetMb * MiB, memory.jsHeapLimitBytes);
  const remainingMb = (budgetBytes - memory.estimatedUsedBytes) / MiB - headroomMb;
  const selectedMb = Math.max(baseMb, Math.min(maxMb, Math.floor(remainingMb / 32) * 32));
  return {...decision, selectedMb, reason: selectedMb > baseMb ? 'estimated-headroom' : 'budget-headroom'};
}

module.exports = {captureMemoryUsage, selectWasmHeapSize, trackHeap};

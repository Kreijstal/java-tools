'use strict';

// Keep logical byte length exact while amortizing repeated cache appends.
// Limit spare capacity so a large cached file cannot double retained memory.
const MAX_SPARE_BYTES = 1024 * 1024;

function growByteView(view, length) {
  if (!(view instanceof Uint8Array) || view.constructor !== Uint8Array || view.byteOffset !== 0 ||
      !(view.buffer instanceof ArrayBuffer) || view.buffer.resizable ||
      !Number.isSafeInteger(length) || length <= view.byteLength) return null;
  if (length <= view.buffer.byteLength) return new Uint8Array(view.buffer, 0, length);
  const spare = Math.min(MAX_SPARE_BYTES, Math.max(4096, Math.ceil(length / 2)));
  let storage;
  try { storage = new Uint8Array(length + spare); }
  catch (error) {
    if (error instanceof RangeError) return null; // Let the exact-size allocator retry.
    throw error;
  }
  storage.set(view);
  return storage.subarray(0, length);
}

module.exports = growByteView;

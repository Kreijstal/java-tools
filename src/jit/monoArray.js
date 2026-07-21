'use strict';

// Keyed loads/stores over the mixed array zoo: plain JS Arrays, {elements}
// wrappers, and (with JVM_WASM_HEAP) seven TypedArray classes backing
// primitive arrays. A single `a[i]` site that sees several of those maps goes
// megamorphic and V8 abandons the fast path — the instanceof chain gives each
// class its own monomorphic IC. Bounds checks are folded into each branch;
// out-of-bounds returns the OOB sentinel (loads) or false (stores) so callers
// throw guest exceptions with their own message text.
//
// Bug-compat with instructions/utils.js: for {elements} wrappers the bounds
// check uses the wrapper's own .length, not elements.length.

const OOB = Symbol('array-index-out-of-bounds');

function load(a, i) {
  const u = i >>> 0;
  // Array.isArray first: it's a cheap builtin, and with the heap off (or for
  // ref arrays) plain Arrays dominate — they must not pay seven failed
  // instanceof prototype walks per element.
  if (Array.isArray(a)) return u < a.length ? a[u] : OOB;
  if (a instanceof Int32Array) return u < a.length ? a[u] : OOB;
  if (a instanceof Int8Array) return u < a.length ? a[u] : OOB;
  if (a instanceof Float32Array) return u < a.length ? a[u] : OOB;
  if (a instanceof Uint16Array) return u < a.length ? a[u] : OOB;
  if (a instanceof Int16Array) return u < a.length ? a[u] : OOB;
  if (a instanceof Float64Array) return u < a.length ? a[u] : OOB;
  if (a instanceof BigInt64Array) return u < a.length ? a[u] : OOB;
  if (a.elements) return u < a.length ? a.elements[u] : OOB;
  return u < a.length ? a[u] : OOB;
}

function store(a, i, v) {
  const u = i >>> 0;
  if (Array.isArray(a)) { if (u < a.length) { a[u] = v; return true; } return false; }
  if (a instanceof Int32Array) { if (u < a.length) { a[u] = v; return true; } return false; }
  if (a instanceof Int8Array) { if (u < a.length) { a[u] = v; return true; } return false; }
  if (a instanceof Float32Array) { if (u < a.length) { a[u] = v; return true; } return false; }
  if (a instanceof Uint16Array) { if (u < a.length) { a[u] = v; return true; } return false; }
  if (a instanceof Int16Array) { if (u < a.length) { a[u] = v; return true; } return false; }
  if (a instanceof Float64Array) { if (u < a.length) { a[u] = v; return true; } return false; }
  if (a instanceof BigInt64Array) { if (u < a.length) { a[u] = v; return true; } return false; }
  if (a.elements) { if (u < a.length) { a.elements[u] = v; return true; } return false; }
  if (u < a.length) { a[u] = v; return true; }
  return false;
}

function len(a) {
  if (Array.isArray(a)) return a.length;
  if (a instanceof Int32Array) return a.length;
  if (a instanceof Int8Array) return a.length;
  if (a instanceof Float32Array) return a.length;
  if (a instanceof Uint16Array) return a.length;
  if (a instanceof Int16Array) return a.length;
  if (a instanceof Float64Array) return a.length;
  if (a instanceof BigInt64Array) return a.length;
  return a.length;
}

module.exports = { OOB, load, store, len };

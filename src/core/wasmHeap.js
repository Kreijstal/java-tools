'use strict';

// Linear heap for primitive Java arrays (JVM_WASM_HEAP=1): each array is a
// TypedArray view over one fixed-size WebAssembly.Memory, bump-allocated and
// never freed. JS/interpreter code indexes the view exactly like the plain
// arrays it replaces (TypedArray coercion matches Java element semantics),
// while compiled wasm can read `view.wasmBase` once per run and then access
// elements with raw loads/stores. The memory never grows, so views never
// detach; when the bump pointer runs out, allocation falls back to ordinary
// TypedArrays (wasmBase undefined) and compiled code takes the import path —
// exhaustion degrades performance, never correctness.

const CTOR = {
  '[Z': Int8Array, '[B': Int8Array, '[C': Uint16Array, '[S': Int16Array,
  '[I': Int32Array, '[J': BigInt64Array, '[F': Float32Array, '[D': Float64Array,
};

class WasmHeap {
  constructor(mb) {
    const pages = Math.ceil((mb * 1024 * 1024) / 65536);
    this.memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
    this.limit = pages * 65536;
    this.top = 8; // offset 0 stays unused; fresh memory is already zeroed
    this.exhausted = false;
    // Typed views for object-field access. The memory never grows, so these
    // are created once and never detach.
    this.i32 = new Int32Array(this.memory.buffer);
    this.f64 = new Float64Array(this.memory.buffer);
    this.i64 = new BigInt64Array(this.memory.buffer);
  }

  // Bump-allocate `bytes` of 8-aligned slab for one object's primitive
  // instance fields. Returns the base offset, or -1 when the heap is spent —
  // callers then keep the object's fields in a plain JS map.
  allocObject(bytes) {
    const base = (this.top + 7) & ~7;
    if (base + bytes > this.limit) {
      if (!this.exhausted) {
        this.exhausted = true;
        process.stderr.write(`[wasmheap] exhausted at ${this.limit} bytes; falling back to plain typed arrays\n`);
      }
      return -1;
    }
    this.top = base + bytes;
    return base;
  }

  // TypedArray view for `desc` ('[I', '[B', ...) or null when desc is not a
  // primitive array descriptor. Zero-filled by construction (memory is fresh
  // and never reused).
  alloc(desc, count) {
    const Ctor = CTOR[desc];
    if (!Ctor) return null;
    const align = Ctor.BYTES_PER_ELEMENT;
    const base = (this.top + align - 1) & ~(align - 1);
    const bytes = count * align;
    if (base + bytes > this.limit) {
      if (!this.exhausted) {
        this.exhausted = true;
        process.stderr.write(`[wasmheap] exhausted at ${this.limit} bytes; falling back to plain typed arrays\n`);
      }
      return new Ctor(count);
    }
    this.top = base + bytes;
    const view = new Ctor(this.memory.buffer, base, count);
    view.wasmBase = base;
    return view;
  }
}

// Shared predicate for "is this a Java array value" — plain legacy arrays or
// TypedArray-backed primitive arrays (DataView is never a Java array).
function isJavaArray(v) {
  return Array.isArray(v) || (ArrayBuffer.isView(v) && !(v instanceof DataView));
}

module.exports = { WasmHeap, isJavaArray };

'use strict';

// Linear heap for primitive Java arrays (JVM_WASM_HEAP=1): each array is a
// TypedArray view over one fixed-size WebAssembly.Memory, bump-allocated and
// never freed. JS/interpreter code indexes the view exactly like the plain
// arrays it replaces (TypedArray coercion matches Java element semantics),
// while compiled wasm can read `view.wasmBase` once per run and then access
// elements with raw loads/stores. When the bump pointer runs out, allocation falls back to ordinary
// TypedArrays (wasmBase undefined) and compiled code takes the import path —
// exhaustion degrades performance, never correctness.
//
// Growth (docs/refactor.md 2.3): the memory is created with initial ===
// maximum by default, so it reserves rather than grows and views never
// detach. That default is not laziness. `memory.grow()` detaches the buffer,
// and a guest array is itself a view into it, so growing while any guest
// array is alive would silently turn it into a zero-length array. Measured,
// not assumed: after grow the old view reports `length === 0` and reads
// return `undefined` without throwing. Reserving is cheap enough to prefer --
// a 256 MB reservation costs ~2 MB RSS untouched. growTo() therefore exists,
// refreshes views through the single refreshViews() hook, and refuses
// whenever a guest array view is outstanding.

const CTOR = {
  '[Z': Int8Array, '[B': Int8Array, '[C': Uint16Array, '[S': Int16Array,
  '[I': Int32Array, '[J': BigInt64Array, '[F': Float32Array, '[D': Float64Array,
};

// Diagnostics must not assume a Node process: the browser bundle ships a
// `process` shim without stderr, and a missing stream turned this one-time
// notice into a TypeError that aborted the guest run.
function warnExhausted(limit) {
  const message = `[wasmheap] exhausted at ${limit} bytes; falling back to plain typed arrays`;
  const stream = typeof process !== "undefined" ? process.stderr : null;
  if (stream && typeof stream.write === "function") stream.write(`${message}\n`);
  else if (typeof console !== "undefined") console.warn(message);
}

// Size-class free lists (docs/refactor.md 2.2: "Implement size-class free
// lists as the first allocation foundation"). Object slabs are binned by their
// 8-byte-rounded size, which is exact-fit and therefore has no internal
// fragmentation; a bin is a stack of free bases. Sizes above
// MAX_BINNED_BYTES are not recycled, because objects that large are rare and a
// bin per size would cost more than it returns.
//
// Nothing calls free() yet, and that is deliberate. The same section is
// explicit that "free lists alone do not establish which guest objects are
// dead; reclaim only when liveness is known." This is the allocator
// foundation; the liveness question is the separate, larger half of Phase 2.
const MAX_BINNED_BYTES = 4096;

// Bounded backward scan for an acceptably-aligned free extent (see
// _takeExtent). Small on purpose: past a few entries, bumping is cheaper than
// hunting.
const EXTENT_SCAN_LIMIT = 8;

// Design A reclamation (docs/phase2-representation.md 7-8). A guest array's
// identity is the JS TypedArray view, so the host GC already knows when the
// array is dead; wrapper death is the liveness signal section 2.2 requires
// before anything may be reclaimed. Opt-in while it is being measured: the
// baseline it has to beat is 5.83 MB/min of stable-menu growth, and a
// reclamation scheme that does not move that number is not worth its overhead.
//
// Soundness rests on an audited property: no global, field cache, or cross-run
// structure holds a bare `wasmBase`. The only consumer outside this file takes
// the array reference and returns its base (`abase`), so the view is reachable
// whenever a base exists. A future cache of `abase` results across a
// suspension point would break this.
function reclaimEnabled() {
  try {
    return typeof process !== "undefined" && process.env &&
      process.env.JVM_WASM_HEAP_RECLAIM !== "0" &&
      typeof FinalizationRegistry === "function";
  } catch (e) {
    return false;
  }
}

class WasmHeap {
  // `mb` is the address space this heap may ever use. `initialMb` is what it
  // commits up front; it defaults to `mb`, which is the historical
  // reserve-everything behaviour and the only shape the guest-array
  // configuration can use (see growTo).
  constructor(mb, initialMb) {
    const pages = Math.ceil((mb * 1024 * 1024) / 65536);
    const startPages = initialMb === undefined
      ? pages
      : Math.min(pages, Math.max(1, Math.ceil((initialMb * 1024 * 1024) / 65536)));
    this.maxPages = pages;
    this.pages = startPages;
    this.memory = new WebAssembly.Memory({ initial: startPages, maximum: pages });
    this.limit = startPages * 65536;
    // Bumped by every refreshViews(). Anything that caches a view or a base
    // across a possible growth must compare this, not assume stability.
    this.viewEpoch = 0;
    // Guest-visible array views handed out and not yet known dead. Growth
    // detaches the buffer, so it is only sound while this is zero.
    this.arrayViewsLive = 0;
    this.growCount = 0;
    this.lastGrowRefusal = null;
    this.top = 8; // offset 0 stays unused; fresh memory is already zeroed,
    // and address 0 can therefore encode null without a separate tag.
    this.exhausted = false;
    // bin index (bytes >> 3) -> stack of free bases of exactly that size.
    this.freeBins = new Map();
    // Array extents are binned separately and by exact byte size. Measurement
    // (docs/phase2-representation.md section 6) puts the whole ~5.8 MB/min
    // menu growth in this allocator, not in object slabs, so this is the bin
    // that matters. Sizes here are sparse and can be large, so a Map keyed by
    // exact rounded size beats a dense table: only sizes the guest actually
    // uses ever get a bin, and exact fit means no internal waste.
    this.arrayBins = new Map();
    this.stats = { bumped: 0, reused: 0, freed: 0, freeBytes: 0,
      arrayBumped: 0, arrayReused: 0, arrayFreed: 0, arrayFreeBytes: 0,
      arrayReclaimed: 0 };
    this.registry = reclaimEnabled()
      ? new FinalizationRegistry((held) => this.reclaimExtent(held))
      : null;
    // Typed views for object-field access. These are internal to this file and
    // to objectModel's slab accessors, which read `heap.i32` on every access
    // rather than caching it, so they can be re-derived after a growth.
    this.refreshViews();
  }

  // The single view-refresh hook docs/refactor.md 2.3 requires. Everything
  // this heap owns that is derived from `memory.buffer` is rebuilt here, and
  // `viewEpoch` advances so an external cache can detect it.
  //
  // It refreshes only views this heap owns. It says nothing about guest array
  // views, which cannot be refreshed at all -- a TypedArray cannot be
  // repointed at a new buffer -- and that asymmetry is the whole reason
  // growTo has a guard.
  refreshViews() {
    const buffer = this.memory.buffer;
    this.i32 = new Int32Array(buffer);
    this.f64 = new Float64Array(buffer);
    this.i64 = new BigInt64Array(buffer);
    this.viewEpoch += 1;
    return this.viewEpoch;
  }

  // Why growth is refused right now, or null when it would be sound.
  //
  // Measured, not assumed (node 22, 2026-09-06): after `memory.grow(1)` an
  // existing `Int32Array` over the old buffer has `length === 0` and reads
  // return `undefined`. It does not throw. A guest `int[]` that silently
  // becomes empty is the worst available failure mode, so the guard is a hard
  // precondition rather than a warning.
  growBlocker() {
    if (this.pages >= this.maxPages) return 'at reserved maximum';
    if (this.arrayViewsLive > 0) {
      return `${this.arrayViewsLive} guest array view(s) would detach`;
    }
    if (!this.registry && this.stats.arrayBumped + this.stats.arrayReused > 0) {
      // Without the registry nothing ever reports a view dead, so
      // arrayViewsLive cannot fall back to zero and must not be trusted.
      return 'array liveness is untracked (reclamation disabled)';
    }
    return null;
  }

  // Grow to at least `bytes` of capacity. Returns true when the heap grew.
  // Refuses -- without growing and without throwing -- whenever growBlocker
  // names a reason, because a refusal costs performance and a wrong growth
  // costs correctness.
  growTo(bytes) {
    const blocker = this.growBlocker();
    if (blocker) {
      this.lastGrowRefusal = blocker;
      return false;
    }
    const wantPages = Math.ceil(bytes / 65536);
    if (wantPages <= this.pages) return false;
    const target = Math.min(this.maxPages, Math.max(wantPages, this.pages * 2));
    try {
      this.memory.grow(target - this.pages);
    } catch (err) {
      this.lastGrowRefusal = `grow threw: ${err.message}`;
      return false;
    }
    this.pages = target;
    this.limit = target * 65536;
    this.growCount += 1;
    this.exhausted = false;
    this.refreshViews();
    return true;
  }

  // Bump-allocate `bytes` of 8-aligned slab for one object's primitive
  // instance fields. Returns the base offset, or -1 when the heap is spent —
  // callers then keep the object's fields in a plain JS map.
  allocObject(bytes) {
    const size = (bytes + 7) & ~7;
    const bin = size <= MAX_BINNED_BYTES ? this.freeBins.get(size >> 3) : null;
    if (bin && bin.length) {
      const base = bin.pop();
      // A recycled slab holds the previous object's field bytes. Callers rely
      // on a fresh slab reading as zero -- that is why the bump path can just
      // hand back untouched memory -- so reuse has to restore that invariant
      // explicitly. Getting this wrong would give a new object the old one's
      // field values, which is exactly the class of bug that is invisible
      // until it corrupts guest state far from here.
      this.i32.fill(0, base >> 2, (base + size) >> 2);
      this.stats.reused += 1;
      this.stats.freeBytes -= size;
      return base;
    }
    const base = (this.top + 7) & ~7;
    if (base + size > this.limit && !this.growTo(base + size)) {
      if (!this.exhausted) {
        this.exhausted = true;
        warnExhausted(this.limit);
      }
      return -1;
    }
    this.top = base + size;
    this.stats.bumped += 1;
    return base;
  }

  // Return an object slab to its size class. `bytes` must be the same size the
  // slab was allocated with; the caller owns that pairing, exactly as it owns
  // the base. Returns true when the extent was recycled, false when it was
  // dropped (too large to bin), so a caller can account for what it lost.
  //
  // No liveness is implied. This reclaims an extent the caller has already
  // determined is dead.
  free(base, bytes) {
    if (!(base > 0)) return false;
    const size = (bytes + 7) & ~7;
    if (size <= 0 || size > MAX_BINNED_BYTES) return false;
    const key = size >> 3;
    let bin = this.freeBins.get(key);
    if (!bin) { bin = []; this.freeBins.set(key, bin); }
    bin.push(base);
    this.stats.freed += 1;
    this.stats.freeBytes += size;
    return true;
  }

  // Bytes the bump pointer has handed out, and what is parked in free lists.
  // `live` is an upper bound on live bytes, not a measurement of liveness.
  usage() {
    return {
      allocated: this.top - 8,
      free: this.stats.freeBytes + this.stats.arrayFreeBytes,
      live: (this.top - 8) - this.stats.freeBytes - this.stats.arrayFreeBytes,
      limit: this.limit,
      reserved: this.maxPages * 65536,
      grows: this.growCount,
      viewEpoch: this.viewEpoch,
      arrayViewsLive: this.arrayViewsLive,
      ...this.stats,
    };
  }

  // TypedArray view for `desc` ('[I', '[B', ...) or null when desc is not a
  // primitive array descriptor. Always reads as zero: a bump-allocated extent
  // because fresh wasm memory is zeroed, a recycled one because freeArray's
  // callers get it cleared here.
  //
  // Extents are 8-aligned regardless of element width, which costs at most 7
  // bytes per array and buys the property that a freed extent is reusable by
  // any array of the same byte size, whatever its element type. Without it a
  // byte array freed at an odd address could not serve an int array and the
  // bins would fragment by alignment as well as size.
  alloc(desc, count) {
    const Ctor = CTOR[desc];
    if (!Ctor) return null;
    const bytes = count * Ctor.BYTES_PER_ELEMENT;
    // Extents are aligned to the element width and sized exactly, never
    // rounded up. An earlier revision rounded every extent to 8 bytes so that
    // a freed extent could be reused by any element type; measurement rejected
    // it. The stable menu allocates ~446k arrays per minute averaging 16.1
    // bytes, so 8-byte rounding cost ~2.5 bytes on each one and raised the
    // steady-state growth this whole section exists to reduce, from 5.83 to
    // 6.86 MB/min (+17.7%). Cross-type reuse is worth less than the padding it
    // would cost on every allocation, reused or not.
    const align = Ctor.BYTES_PER_ELEMENT;
    const reused = this._takeExtent(bytes, align);
    if (reused >= 0) {
      const view = new Ctor(this.memory.buffer, reused, count);
      // A recycled extent still holds the previous array's elements. Callers
      // rely on a new Java array being zero, so restore that here.
      view.fill(Ctor === BigInt64Array ? 0n : 0);
      view.wasmBase = reused;
      this.stats.arrayReused += 1;
      this.stats.arrayFreeBytes -= bytes;
      this.watch(view, reused, bytes);
      return view;
    }
    const base = (this.top + align - 1) & ~(align - 1);
    if (base + bytes > this.limit && !this.growTo(base + bytes)) {
      if (!this.exhausted) {
        this.exhausted = true;
        warnExhausted(this.limit);
      }
      return new Ctor(count);
    }
    this.top = base + bytes;
    this.stats.arrayBumped += 1;
    const view = new Ctor(this.memory.buffer, base, count);
    view.wasmBase = base;
    this.watch(view, base, bytes);
    return view;
  }

  // Register a view so its extent returns to the free list when the view dies.
  // The view is also the unregister token, so an explicit freeArray can cancel
  // the registration and avoid binning the same extent twice.
  watch(view, base, bytes) {
    // Only counted when something can report the view dead again. Without the
    // registry this would climb to millions over a session and read like a
    // leak in the sampler; growBlocker refuses on the untracked case anyway,
    // from the allocation stats rather than from this counter.
    if (!this.registry) return;
    this.arrayViewsLive += 1;
    // Every heap-backed view is registered, including extents too large to
    // bin. Binning is decided in reclaimExtent; registration here is also what
    // lets arrayViewsLive fall back to zero, which is growTo's precondition.
    this.registry.register(view, { base, bytes }, view);
  }

  // Called by the host GC after a view becomes unreachable. Carries no view --
  // by definition there is none left -- so it bins by the recorded extent.
  reclaimExtent(held) {
    if (!held) return;
    if (this.arrayViewsLive > 0) this.arrayViewsLive -= 1;
    const { base, bytes } = held;
    if (!(base > 0) || !(bytes > 0) || bytes > MAX_BINNED_BYTES) return;
    let bin = this.arrayBins.get(bytes);
    if (!bin) { bin = []; this.arrayBins.set(bytes, bin); }
    bin.push(base);
    this.stats.arrayReclaimed += 1;
    this.stats.arrayFreeBytes += bytes;
  }

  // Pop a free extent of exactly `bytes` whose base satisfies `align`, or -1.
  //
  // Bins are keyed by exact size, so they are exact-fit and carry no internal
  // fragmentation. Alignment is checked at pop rather than folded into the key
  // because a freed extent is often better aligned than its own element type
  // required — a byte[] extent that happens to start 4-aligned can still serve
  // an int[] of the same size. The scan is bounded so a bin full of
  // unusably-aligned bases degrades to bump allocation instead of a long walk.
  _takeExtent(bytes, align) {
    const bin = this.arrayBins.get(bytes);
    if (!bin || !bin.length) return -1;
    const mask = align - 1;
    const floor = Math.max(0, bin.length - EXTENT_SCAN_LIMIT);
    for (let i = bin.length - 1; i >= floor; i -= 1) {
      const base = bin[i];
      if ((base & mask) === 0) {
        if (i === bin.length - 1) bin.pop();
        else bin.splice(i, 1);
        return base;
      }
    }
    return -1;
  }

  // Return an array extent to its size class. Takes the view `alloc` handed
  // out; a fallback array (no `wasmBase`) is not ours and is refused.
  //
  // No liveness is implied, and this has no caller yet, for the same reason
  // free() does not: docs/refactor.md 2.2 requires that reclamation wait until
  // liveness is known. This is the allocator half of the foundation for the
  // allocator that measurement showed actually leaks.
  freeArray(view) {
    if (!view || view.wasmBase === undefined || view.wasmBase === null) return false;
    const base = view.wasmBase;
    if (!(base > 0)) return false;
    const bytes = view.byteLength;
    if (bytes <= 0) return false;
    if (bytes > MAX_BINNED_BYTES) return false;
    if (this.registry) this.registry.unregister(view);
    if (this.arrayViewsLive > 0) this.arrayViewsLive -= 1;
    let bin = this.arrayBins.get(bytes);
    if (!bin) { bin = []; this.arrayBins.set(bytes, bin); }
    bin.push(base);
    this.stats.arrayFreed += 1;
    this.stats.arrayFreeBytes += bytes;
    return true;
  }
}

// Shared predicate for "is this a Java array value" — plain legacy arrays or
// TypedArray-backed primitive arrays (DataView is never a Java array).
function isJavaArray(v) {
  return Array.isArray(v) || (ArrayBuffer.isView(v) && !(v instanceof DataView));
}

module.exports = { WasmHeap, isJavaArray };

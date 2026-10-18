'use strict';

// Shared by JavaScript guards and Wasm imports. Readiness can be reset when a
// class is replaced or state is restored, so generated code must read live state.
let readinessModule;
function getReadinessModule() {
  if (!readinessModule) {
    // (module (import "env" "ready" (global (mut i32)))
    //   (func (export "get") (result i32) global.get 0))
    readinessModule = new WebAssembly.Module(Uint8Array.from([
      0, 97, 115, 109, 1, 0, 0, 0,
      1, 5, 1, 96, 0, 1, 127,
      2, 14, 1, 3, 101, 110, 118, 5, 114, 101, 97, 100, 121, 3, 127, 1,
      3, 2, 1, 0,
      7, 7, 1, 3, 103, 101, 116, 0, 0,
      10, 6, 1, 4, 0, 35, 0, 11,
    ]));
  }
  return readinessModule;
}

class ClassInitializationToken {
  constructor(state) {
    this.state = state;
    this._initialized = state === 'INITIALIZED';
    this._wasmReady = null;
    this._wasmGuard = null;
    this._heapReadiness = null;
    this._heapReadinessAddresses = null;
  }

  get initialized() { return this._initialized; }
  set initialized(value) {
    this._initialized = Boolean(value);
    if (this._wasmReady) this._wasmReady.value = this._initialized ? 1 : 0;
    if (this._heapReadiness) {
      let retained = 0;
      for (const entry of this._heapReadiness) {
        const memory = entry.memory.deref();
        if (!memory) continue;
        // An imported memory may outlive its heap wrapper. Use its current
        // buffer after growth without retaining abandoned heaps or memories.
        new Int32Array(memory.buffer,entry.address,1)[0] = this._initialized ? 1 : 0;
        this._heapReadiness[retained++] = entry;
      }
      this._heapReadiness.length = retained;
    }
  }

  wasmReadinessAddress(heap) {
    // A custom guard may have observable behavior beyond this token's flag.
    // It must retain the original callable path.
    if (this.wasmReadinessGuard !== defaultReadinessGuard ||
        typeof WeakRef !== 'function' || !heap?.memory) return undefined;
    const known = this._heapReadinessAddresses?.get(heap.memory);
    if (known !== undefined) return known;
    const address = heap.allocObject(8);
    if (!Number.isInteger(address) || address < 0 || address > 0x7ffffff8) return undefined;
    heap.i32[address >>> 2] = this._initialized ? 1 : 0;
    (this._heapReadinessAddresses ||= new WeakMap()).set(heap.memory,address);
    (this._heapReadiness ||= []).push({memory:new WeakRef(heap.memory),address});
    return address;
  }

  wasmReadinessGuard() {
    if (!this._wasmGuard) {
      this._wasmReady = new WebAssembly.Global(
        {value: 'i32', mutable: true}, this._initialized ? 1 : 0);
      this._wasmGuard = new WebAssembly.Instance(getReadinessModule(),
        {env: {ready: this._wasmReady}}).exports.get;
    }
    // Import the Wasm function itself: a JS wrapper would restore the costly
    // Wasm-to-JS transition at every guarded basic block.
    return this._wasmGuard;
  }
}

const defaultReadinessGuard = ClassInitializationToken.prototype.wasmReadinessGuard;

module.exports = ClassInitializationToken;

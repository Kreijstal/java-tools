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
  }

  get initialized() { return this._initialized; }
  set initialized(value) {
    this._initialized = Boolean(value);
    if (this._wasmReady) this._wasmReady.value = this._initialized ? 1 : 0;
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

module.exports = ClassInitializationToken;

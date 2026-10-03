'use strict';
const {T, toWasmValue} = require('./wasmShared');

// Both Wasm backends resolve storage once. Reuse the same live cells as
// generated JS, while preserving Map semantics for cold or removed keys.
function bindStaticFieldAccessors(container, key, type) {
  const cell = typeof container.cell === 'function' ? container.cell(key) : null;
  const read = cell ? () => cell.value : () => container.get(key);
  const get = type === T.i32 ? () => {
    const value = read();
    return typeof value === 'boolean' ? (value ? 1 : 0) : value;
  } : type === T.ref ? read : () => toWasmValue(type, read());
  const set = cell ? value => {
    if (cell.present === true) cell.value = value;
    else container.set(key, value);
  } : value => container.set(key, value);
  return {get, set};
}

module.exports = {bindStaticFieldAccessors};

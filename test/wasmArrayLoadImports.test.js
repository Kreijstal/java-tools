'use strict';
const test = require('tape');
const { addArrayImports, addI32ArrayLoadImports } = require('../src/jit/wasmRuntimeImports');
const { WasmHeap } = require('../src/core/wasmHeap');

function importsFor(trace) {
  const functions = new Map();
  const registry = {
    addImport(name, params, results, fn) {
      functions.set(name, fn);
      return functions.size - 1;
    },
  };
  addArrayImports(registry, 'array-load-test');
  addI32ArrayLoadImports(registry, 'array-load-test', trace);
  for (const op of ['iaload', 'baload', 'caload', 'saload']) {
    registry.i32LoadImportFor(op);
  }
  return functions;
}

function outcome(load, array, index) {
  try { return { value: load(array, index) }; }
  catch (error) { return { error }; }
}

test('typed Wasm array imports preserve generic loads and guest errors', t => {
  const imports = importsFor();
  const generic = imports.get('aget_i');
  const heap = new WasmHeap(1);
  const kinds = [
    ['[I', 'int', Int32Array], ['[B', 'byte', Int8Array],
    ['[C', 'char', Uint16Array], ['[S', 'short', Int16Array],
    ['[Z', 'boolean', Int8Array],
  ];
  const values = [-2147483648, -32769, -129, -1, 0, 127, 255, 65535, 2147483647];
  const cases = [];
  for (const [type, elementType, Ctor] of kinds) {
    const heapArray = heap.alloc(type, values.length);
    heapArray.set(values);
    for (const array of [new Ctor(values), heapArray, values.slice(),
      { elements: values.slice(), length: values.length }]) {
      Object.assign(array, { type, elementType });
      cases.push(array);
    }
  }
  // Legacy boolean annotations and mismatched descriptors must still use
  // the existing normalizer, even when the backing has a fast typed shape.
  cases.push(Object.assign(new Int8Array([-128, 0, 2]), {
    type: '[B', elementType: 'boolean',
  }));
  cases.push(new Int32Array([1, -1]));
  cases.push(null, undefined);
  for (const op of ['iaload', 'baload', 'caload', 'saload']) {
    const load = imports.get('aget_' + op);
    for (let n = 0; n < cases.length; n++) {
      const array = cases[n];
      const indices = [-1, 0, 1, 4, (array?.length || 0) - 1, array?.length || 0, 0x7fffffff];
      t.deepEqual(indices.map(i => outcome(load, array, i)),
        indices.map(i => outcome(generic, array, i)),
        `${op} backing ${n}: values, narrowing, null and bounds errors agree`);
    }
  }
  t.end();
});

test('typed and fallback loads each emit one diagnostic trace', t => {
  const events = [];
  const imports = importsFor((...event) => events.push(event));
  for (const [op, Ctor, type] of [
    ['iaload', Int32Array, '[I'], ['baload', Int8Array, '[B'],
    ['caload', Uint16Array, '[C'], ['saload', Int16Array, '[S'],
  ]) {
    const load = imports.get('aget_' + op);
    for (const array of [Object.assign(new Ctor([42]), { type }),
      Object.assign([42], { type }), null]) {
      for (const index of [0, 1]) {
        const before = events.length;
        outcome(load, array, index);
        t.equal(events.length, before + 1, 'successful and throwing reads trace once');
        t.deepEqual(events.at(-1), ['aget_' + op, array, index], 'trace retains original operands');
      }
    }
  }
  t.end();
});

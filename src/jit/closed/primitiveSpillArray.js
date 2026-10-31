'use strict';
const {VT} = require('./wasmBuilder');

// Closed primitive handles with a negative base own a canonical TypedArray.
// The emitted access has already checked null and bounds against that same
// handle. Pass its externref view directly: no reference conversion, nested
// helper-module call, exception adapter or repeated dynamic check is needed.
// Separate functions keep the element-access sites specific to their kinds.
const accesses = {
  iaload: (a, i) => a[i], laload: (a, i) => a[i],
  faload: (a, i) => a[i], daload: (a, i) => a[i],
  baload: (a, i) => a[i], caload: (a, i) => a[i], saload: (a, i) => a[i],
  iastore: (a, i, v) => {a[i] = v;}, lastore: (a, i, v) => {a[i] = v;},
  fastore: (a, i, v) => {a[i] = v;}, dastore: (a, i, v) => {a[i] = v;},
  bastore: (a, i, v) => {a[i] = v;}, castore: (a, i, v) => {a[i] = v;}, sastore: (a, i, v) => {a[i] = v;},
};
const types = {I: VT.i32, J: VT.i64, F: VT.f32, D: VT.f64};

function primitiveSpillArrayImport(world, op, kind) {
  const store = op.endsWith('astore'), type = types[kind];
  if (!accesses[op] || type === undefined) throw new Error('Unsupported primitive array access: ' + op);
  return world.pureImport('spill:' + op, store ? [VT.externref, VT.i32, type] : [VT.externref, VT.i32],
    store ? [] : [type], accesses[op], {kind:'spill-array', op, valueKind:kind});
}

module.exports = {primitiveSpillArrayImport};

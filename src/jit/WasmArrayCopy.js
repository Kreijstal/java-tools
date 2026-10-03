"use strict";
const {T, OP, uleb, sleb} = require('./wasmShared');

// High bits distinguish representations; low bits encode element byte width.
// Equal widths alone would incorrectly bit-copy float/int or signed/unsigned.
const kinds = new Map([
  [Int8Array, 0x11], [Uint8Array, 0x21], [Int16Array, 0x32], [Uint16Array, 0x42],
  [Int32Array, 0x54], [Uint32Array, 0x64], [Float32Array, 0x74], [Float64Array, 0x88],
  [BigInt64Array, 0x98], [BigUint64Array, 0xa8],
]);
function heapCopyKind(heap, array) {
  if (!ArrayBuffer.isView(array) || array.buffer !== heap.memory.buffer ||
      !Number.isInteger(array.wasmBase) || array.wasmBase !== array.byteOffset) return 0;
  return kinds.get(array.constructor) || 0;
}

function emitHeapCopy(compiler, node, call, out) {
  compiler.heapImports();
  compiler.usedHeap = true;
  if (compiler.copyKindIdx === undefined) {
    const heap = compiler.heap;
    compiler.copyKindIdx = compiler.addImport('arraycopy_heap_kind', [T.ref], [T.i32],
      array => heapCopyKind(heap, array));
  }
  const source = compiler.arrayCacheFor(node.args[0]);
  const target = compiler.arrayCacheFor(node.args[2]);
  for (const cache of [source, target]) {
    if (cache.copyKind !== undefined) continue;
    cache.copyKind = compiler.nextLocal++;
    compiler.declared.push(T.i32);
  }
  const get = local => [OP.local_get, ...uleb(local)];
  const use = index => compiler.useOf(node.args[index]);
  const width = [...get(source.copyKind), OP.i32_const, ...sleb(15), OP.i32_and];
  const address = (cache, index) => [...get(cache.base), ...use(index), ...width, OP.i32_mul, OP.i32_add];
  // Unsigned pos <= length rejects negative positions. Compare count against
  // remaining space rather than pos+count, which could overflow an i32.
  const range = (cache, index) => [
    ...get(cache.len), ...use(index), OP.i32_ge_u,
    ...get(cache.len), ...use(index), OP.i32_sub, ...use(4), OP.i32_ge_u, OP.i32_and,
  ];
  out.push(
    ...compiler.lazyArrayCacheFill(source), ...compiler.lazyArrayCacheFill(target),
    ...get(source.copyKind), OP.i32_eqz, OP.i32_eqz,
    ...get(source.copyKind), ...get(target.copyKind), OP.i32_eq, OP.i32_and,
    ...range(source, 1), OP.i32_and, ...range(target, 3), OP.i32_and,
    OP.if, 0x40,
    ...address(target, 3), ...address(source, 1), ...use(4), ...width, OP.i32_mul,
    // memory.copy, destination memory 0, source memory 0. Overlap is memmove.
    0xfc, 0x0a, 0x00, 0x00,
    OP.else,
  );
  for (let index = 0; index < node.args.length; index++) out.push(...use(index));
  out.push(OP.call, ...uleb(call.idx), OP.end);
}
module.exports = {heapCopyKind, emitHeapCopy};

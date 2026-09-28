'use strict';
const {withThrows} = require('./helpers');

// Weak keys keep detached or retired Wasm heaps collectible. Values refer to
// their own keys only; no per-copy view or source snapshot is retained.
const byteViews = new WeakMap();
function bufferBytes(buffer) {
  let bytes = byteViews.get(buffer);
  if (!bytes) {
    bytes = new Uint8Array(buffer);
    byteViews.set(buffer, bytes);
  }
  return bytes;
}

function copyRange(src, srcPos, dest, destPos, length) {
  if (src === null || dest === null) {
    throw {
      type: 'java/lang/NullPointerException'
    };
  }
  if (srcPos < 0 || destPos < 0 || length < 0 || srcPos + length > src.length || destPos + length > dest.length) {
    throw {
      type: 'java/lang/ArrayIndexOutOfBoundsException'
    };
  }
  // JVM primitive arrays may be views into the shared Wasm heap. Native
  // typed-array copies preserve overlap (including distinct views of the
  // same buffer) and avoid allocating a snapshot of the entire source.
  // Keep reference arrays and mixed representations on the existing path.
  if (ArrayBuffer.isView(src) && ArrayBuffer.isView(dest) &&
      src.BYTES_PER_ELEMENT && src.constructor === dest.constructor) {
    if (src === dest) dest.copyWithin(destPos, srcPos, srcPos + length);
    else if (src.buffer === dest.buffer) {
      const bytes = bufferBytes(src.buffer);
      const width = src.BYTES_PER_ELEMENT;
      const from = src.byteOffset + srcPos * width;
      const to = dest.byteOffset + destPos * width;
      bytes.copyWithin(to, from, from + length * width);
    } else dest.set(src.subarray(srcPos, srcPos + length), destPos);
    return;
  }
  if (src === dest) {
    const srcCopy = [...src];
    for (let i = 0; i < length; i++) {
      dest[destPos + i] = srcCopy[srcPos + i];
    }
  } else {
    for (let i = 0; i < length; i++) {
      dest[destPos + i] = src[srcPos + i];
    }
  }
}

const arraycopy = withThrows((jvm, receiver, args) => copyRange(...args),
  ['java/lang/NullPointerException', 'java/lang/ArrayIndexOutOfBoundsException']);
// A synchronous Wasm import can pass its already-positional operands directly.
// This belongs to this native function, so replacing the JRE native still works.
arraycopy.jvmPositionalBody = copyRange;
module.exports = arraycopy;

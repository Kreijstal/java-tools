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

const PRIMITIVE_NAMES = { Z: 'boolean', B: 'byte', C: 'char', S: 'short', I: 'int', J: 'long', F: 'float', D: 'double' };

function isArray(value) {
  return Array.isArray(value) || ArrayBuffer.isView(value);
}

// int[], java.lang.String[][] ...
function javaTypeName(type) {
  let dims = 0;
  while (type[dims] === '[') dims++;
  const base = type.slice(dims);
  const name = PRIMITIVE_NAMES[base] || (base[0] === 'L' ? base.slice(1, -1) : base).replace(/\//g, '.');
  return name + '[]'.repeat(dims);
}

function arrayStoreException(message) {
  return { type: 'java/lang/ArrayStoreException', message };
}

// HotSpot's checks before any element moves: both operands are arrays, and
// primitive arrays only copy into the same primitive kind.
function checkArrayKinds(src, dest) {
  for (const [value, role] of [[src, 'source'], [dest, 'destination']]) {
    if (!isArray(value)) {
      const { runtimeClassOf } = require('../core/arrayStore');
      const name = (runtimeClassOf(value) || 'java/lang/Object').replace(/\//g, '.');
      throw arrayStoreException(`arraycopy: ${role} type ${name} is not an array`);
    }
  }
  const srcType = typeof src.type === 'string' ? src.type : null;
  const destType = typeof dest.type === 'string' ? dest.type : null;
  if (!srcType || !destType || srcType === destType) return;
  if (srcType.length === 2 || destType.length === 2) {
    throw arrayStoreException(`arraycopy: type mismatch: can not copy ${javaTypeName(srcType)} into ${javaTypeName(destType)}`);
  }
}

// Reference arrays of different types: each element must fit the destination;
// the elements before the first that does not are copied.
function checkedElementCount(src, srcPos, dest, length, jvm) {
  if (!jvm || src.type === dest.type || ArrayBuffer.isView(dest)) return length;
  const { arrayStoreOk, elementTypeOf } = require('../core/arrayStore');
  const element = elementTypeOf(dest);
  if (element === undefined || element === 'java/lang/Object') return length;
  for (let i = 0; i < length; i++) {
    if (!arrayStoreOk(jvm, dest, src[srcPos + i])) return i;
  }
  return length;
}

function copyRange(src, srcPos, dest, destPos, length, jvm) {
  if (src === null || dest === null) {
    throw {
      type: 'java/lang/NullPointerException'
    };
  }
  checkArrayKinds(src, dest);
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
    } else if (srcPos === 0 && length === src.length) {
      dest.set(src, destPos);
    } else dest.set(src.subarray(srcPos, srcPos + length), destPos);
    return;
  }
  const fits = checkedElementCount(src, srcPos, dest, length, jvm);
  if (fits < length) {
    for (let i = 0; i < fits; i++) dest[destPos + i] = src[srcPos + i];
    throw arrayStoreException(`arraycopy: element type mismatch: can not cast one of the elements of ${
      javaTypeName(src.type)} to the type of the destination array, ${javaTypeName(dest.type).slice(0, -2)}`);
  }
  // Copy overlapping reference-array ranges backwards when the destination
  // starts inside the source range. This preserves snapshot semantics without
  // allocating a snapshot of the entire array for a small shift.
  if (src === dest && destPos > srcPos && destPos < srcPos + length) {
    for (let i = length - 1; i >= 0; i--) {
      dest[destPos + i] = src[srcPos + i];
    }
  } else {
    for (let i = 0; i < length; i++) {
      dest[destPos + i] = src[srcPos + i];
    }
  }
}

const arraycopy = withThrows((jvm, receiver, args) => copyRange(args[0], args[1], args[2], args[3], args[4], jvm),
  ['java/lang/NullPointerException', 'java/lang/ArrayIndexOutOfBoundsException', 'java/lang/ArrayStoreException']);
// A synchronous Wasm import can pass its already-positional operands directly
// (and the JVM, for element checks).
// This belongs to this native function, so replacing the JRE native still works.
arraycopy.jvmPositionalBody = copyRange;
// The compiler must not bypass a replaced native or positional implementation.
arraycopy.supportsHeapCopy = native => native === arraycopy && native.jvmPositionalBody === copyRange;
module.exports = arraycopy;

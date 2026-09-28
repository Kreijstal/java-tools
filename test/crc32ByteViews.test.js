'use strict';
const test = require('tape');
const CRC32 = require('../src/jre/java/util/zip/CRC32');

// Independent bit-at-a-time oracle covers the library's >=16-byte fast path.
function reference(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte & 255;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return BigInt((~crc) >>> 0);
}

test('CRC32 byte views preserve offsets, signed octets and incremental state', t => {
  for (const Type of [Int8Array, Uint8Array, Uint8ClampedArray]) {
    const storage = new Type(160);
    for (let i = 0; i < storage.length; i++) storage[i] = (i * 79 + 128) & 255;
    const bytes = storage.subarray(11, 149);
    const before = Array.from(storage);
    // Copying this view is unnecessary and can cause a large transient heap
    // spike. A valid checksum must not depend on TypedArray.prototype.slice.
    bytes.slice = () => { throw new Error('Byte storage was copied'); };
    for (const wrapped of [false, true]) {
      const input = wrapped ? {array: bytes} : bytes;
      const obj = {};
      CRC32.methods['<init>()V'](null, obj, []);
      CRC32.methods['update([BII)V'](null, obj, [input, 7, 65]);
      t.equal(CRC32.methods['getValue()J'](null, obj, []), reference(bytes.subarray(7, 72)), `${Type.name}: offset range (${wrapped})`);
      CRC32.methods['update([BII)V'](null, obj, [input, 72, 19]);
      t.equal(CRC32.methods['getValue()J'](null, obj, []), reference(bytes.subarray(7, 91)), 'incremental seed is preserved');
      CRC32.methods['update([BII)V'](null, obj, [input, bytes.length, 0]);
      t.equal(CRC32.methods['getValue()J'](null, obj, []), reference(bytes.subarray(7, 91)), 'empty trailing range preserves checksum');
      t.deepEqual(Array.from(storage), before, 'source storage is unchanged');
    }
  }
  const bytes = Array.from({length: 100}, (_, i) => (i * 73 & 255) - 128);
  const obj = {};
  CRC32.methods['<init>()V'](null, obj, []);
  CRC32.methods['update([BII)V'](null, obj, [bytes, 3, 81]);
  t.equal(CRC32.methods['getValue()J'](null, obj, []), reference(bytes.slice(3, 84)), 'ordinary signed arrays retain normalization');
  t.end();
});

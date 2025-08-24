const crc32 = require('crc-32');

module.exports = {
  'java/util/zip/CRC32': {
    '<init>()V': (thread, locals) => {
      const self = locals[0];
      self['java/util/zip/CRC32/crc'] = 0;
      thread.return();
    },
    'reset()V': (thread, locals) => {
      const self = locals[0];
      self['java/util/zip/CRC32/crc'] = 0;
      thread.return();
    },
    'update([BII)V': (thread, locals) => {
      const self = locals[0];
      const b = locals[1];
      const off = locals[2];
      const len = locals[3];
      
      // Handle both array formats - direct arrays and arrays with array property
      let byteArray;
      if (b && b.array) {
        byteArray = b.array;
      } else if (Array.isArray(b)) {
        byteArray = b;
      } else {
        throw new Error('Invalid byte array format');
      }
      
      const slicedB = byteArray.slice(off, off + len);
      let crc = self['java/util/zip/CRC32/crc'];
      crc = crc32.buf(slicedB, crc);
      self['java/util/zip/CRC32/crc'] = crc;
      thread.return();
    },
    'getValue()J': (thread, locals) => {
      const self = locals[0];
      const crc = self['java/util/zip/CRC32/crc'];
      // Return the CRC value as a BigInt for proper long handling
      return BigInt(crc >>> 0);
    },
  },
};

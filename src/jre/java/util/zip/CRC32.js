const crc32 = require('crc-32');

module.exports = {
  super: "java/lang/Object",
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj['java/util/zip/CRC32/crc'] = 0;
    },
    'reset()V': (jvm, obj, args) => {
      obj['java/util/zip/CRC32/crc'] = 0;
    },
    'update([BII)V': (jvm, obj, args) => {
      const b = args[0];
      const off = args[1];
      const len = args[2];
      
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
      let crc = obj['java/util/zip/CRC32/crc'];
      crc = crc32.buf(slicedB, crc);
      obj['java/util/zip/CRC32/crc'] = crc;
    },
    'getValue()J': (jvm, obj, args) => {
      const crc = obj['java/util/zip/CRC32/crc'];
      // Return the CRC value as a BigInt for proper long handling
      return BigInt(crc >>> 0);
    },
  },
};

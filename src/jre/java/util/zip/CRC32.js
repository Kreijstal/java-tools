const crc32 = require('crc-32');
const { withThrows } = require('../../../helpers');

module.exports = {
  super: "java/lang/Object",
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj['java/util/zip/CRC32/crc'] = 0;
    },
    'reset()V': (jvm, obj, args) => {
      obj['java/util/zip/CRC32/crc'] = 0;
    },
    'update([BII)V': withThrows((jvm, obj, args) => {
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
        throw {
          type: 'java/lang/IllegalArgumentException',
          message: 'Invalid byte array format',
        };
      }
      
      // Java byte arrays contain signed values (-128..127), while crc-32
      // expects octets. Passing the signed JS array through directly changes
      // every byte with its high bit set and produces a different checksum.
      const slicedB = Uint8Array.from(
        byteArray.slice(off, off + len),
        (value) => value & 0xff,
      );
      let crc = obj['java/util/zip/CRC32/crc'];
      crc = crc32.buf(slicedB, crc);
      obj['java/util/zip/CRC32/crc'] = crc;
      if (process.env.JVM_DEBUG_ZIP) {
        let h = 0x811c9dc5;
        for (let i = 0; i < slicedB.length; i++) { h ^= slicedB[i] & 0xff; h = (h * 0x01000193) >>> 0; }
        console.error(`[crc32] update off=${off} len=${len} -> ${(crc >>> 0).toString(16)} fnv=${h.toString(16)}`);
      }
    }, ['java/lang/IllegalArgumentException']),
    'getValue()J': (jvm, obj, args) => {
      const crc = obj['java/util/zip/CRC32/crc'];
      // Return the CRC value as a BigInt for proper long handling
      return BigInt(crc >>> 0);
    },
  },
};

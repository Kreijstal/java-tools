const crypto = require('crypto');
const { withThrows } = require('../../helpers');

module.exports = {
  super: "java/util/Random",
  methods: {
    '<init>()V': (jvm, obj, args) => {
      // Initialize SecureRandom - no need to do anything special
    },
    'setSeed(J)V': (jvm, obj, args) => {
      // SecureRandom is automatically seeded from system entropy.
    },
    'setSeed([B)V': withThrows((jvm, obj, args) => {
      // SecureRandom is automatically seeded from system entropy.
    }, ['java/lang/UnsupportedOperationException']),
    'nextInt()I': (jvm, obj, args) => {
      const buffer = crypto.randomBytes(4);
      return buffer.readInt32BE(0);
    },
    'nextInt(I)I': withThrows((jvm, obj, args) => {
        const bound = args[0];
        if (bound <= 0) {
            throw { type: 'java/lang/IllegalArgumentException', message: 'bound must be positive' };
        }
        return crypto.randomInt(bound);
    }, ['java/lang/IllegalArgumentException']),
    'nextBytes([B)V': withThrows((jvm, obj, args) => {
      const byteArray = args[0];
      let bytes;
      if (byteArray && byteArray.array) {
        bytes = byteArray.array;
      } else if (Array.isArray(byteArray)) {
        bytes = byteArray;
      } else {
        throw { type: 'java/lang/IllegalArgumentException', message: 'Invalid byte array format' };
      }
      const randomBytes = crypto.randomBytes(bytes.length);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = randomBytes.readInt8(i);
      }
    }, ['java/lang/IllegalArgumentException']),
    'nextLong()J': (jvm, obj, args) => {
      const buffer = crypto.randomBytes(8);
      return buffer.readBigInt64BE(0);
    },
    'nextDouble()D': (jvm, obj, args) => {
      const buffer = crypto.randomBytes(8);
      // Use top 53 bits for precision for a double in [0, 1)
      const longVal = buffer.readBigInt64BE(0);
      const doubleVal = Number(longVal >> 11n) / (2**53);
      return doubleVal;
    },
  },
};

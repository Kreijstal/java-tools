const crypto = require('crypto');

module.exports = {
  super: 'java/util/Random',
  methods: {
    '<init>()V': (jvm, obj, args) => {
      // empty constructor
    },
    'setSeed(J)V': (jvm, obj, args) => {
      // supplements the existing seed
    },
    'setSeed([B)V': (jvm, obj, args) => {
      // supplements the existing seed
    },
    'nextBytes([B)V': (jvm, obj, args) => {
      const bytes = args[0];
      const randomBytes = crypto.randomBytes(bytes.length);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = randomBytes[i];
      }
    },
    'nextInt()I': (jvm, obj, args) => {
      const buffer = crypto.randomBytes(4);
      return buffer.readInt32BE(0);
    },
    'generateSeed(I)[B': (jvm, obj, args) => {
      const numBytes = args[0];
      const seed = crypto.randomBytes(numBytes);
      const byteArray = new Int8Array(seed);
      byteArray.type = '[B';
      return byteArray;
    },
  },
};

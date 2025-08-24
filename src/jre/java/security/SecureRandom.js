const crypto = require('crypto');

module.exports = {
  super: "java/util/Random",
  methods: {
    '<init>()V': (jvm, obj, args) => {
      // Initialize SecureRandom - no need to do anything special
    },
    'nextInt()I': (jvm, obj, args) => {
      const buffer = crypto.randomBytes(4);
      return buffer.readInt32BE(0);
    },
  },
};

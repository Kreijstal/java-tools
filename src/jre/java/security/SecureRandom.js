const nodeCrypto = require('crypto');
const { withThrows } = require('../../helpers');

function fillRandomBytes(length) {
  const bytes = new Uint8Array(length);
  const webCrypto = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
  if (webCrypto && typeof webCrypto.getRandomValues === 'function') {
    webCrypto.getRandomValues(bytes);
    return bytes;
  }
  if (nodeCrypto && typeof nodeCrypto.randomFillSync === 'function') {
    nodeCrypto.randomFillSync(bytes);
    return bytes;
  }
  if (nodeCrypto && typeof nodeCrypto.randomBytes === 'function') {
    bytes.set(nodeCrypto.randomBytes(length));
    return bytes;
  }
  throw new Error('Secure random entropy is unavailable');
}

function randomUint32() {
  const bytes = fillRandomBytes(4);
  return ((bytes[0] * 0x1000000) + (bytes[1] << 16) +
    (bytes[2] << 8) + bytes[3]) >>> 0;
}

function randomInt(bound) {
  const unsignedBound = bound >>> 0;
  const limit = Math.floor(0x100000000 / unsignedBound) * unsignedBound;
  let value;
  do {
    value = randomUint32();
  } while (value >= limit);
  return value % unsignedBound;
}

function randomLong() {
  const bytes = fillRandomBytes(8);
  let value = 0n;
  for (const byte of bytes) value = value << 8n | BigInt(byte);
  return BigInt.asIntN(64, value);
}

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
      return randomUint32() | 0;
    },
    'nextInt(I)I': withThrows((jvm, obj, args) => {
        const bound = args[0];
        if (bound <= 0) {
            throw { type: 'java/lang/IllegalArgumentException', message: 'bound must be positive' };
        }
        return randomInt(bound);
    }, ['java/lang/IllegalArgumentException']),
    'nextBytes([B)V': withThrows((jvm, obj, args) => {
      const byteArray = args[0];
      let bytes;
      if (byteArray && byteArray.array) {
        bytes = byteArray.array;
      } else if (Array.isArray(byteArray) || ArrayBuffer.isView(byteArray)) {
        bytes = byteArray;
      } else {
        throw { type: 'java/lang/IllegalArgumentException', message: 'Invalid byte array format' };
      }
      const randomBytes = fillRandomBytes(bytes.length);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = randomBytes[i] << 24 >> 24;
      }
    }, ['java/lang/IllegalArgumentException']),
    'nextLong()J': (jvm, obj, args) => {
      return randomLong();
    },
    'nextDouble()D': (jvm, obj, args) => {
      const unsigned = BigInt.asUintN(64, randomLong());
      return Number(unsigned >> 11n) / 0x20000000000000;
    },
  },
  _test: { fillRandomBytes, randomInt, randomLong, randomUint32 },
};

module.exports = {
  super: 'java/lang/Object',
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj['java/util/Random/seed'] = BigInt(Date.now());
    },
    'setSeed(J)V': (jvm, obj, args) => {
      const seed = args[0];
      obj['java/util/Random/seed'] = (seed ^ 0x5DEECE66Dn) & ((1n << 48n) - 1n);
      delete obj['java/util/Random/haveNextNextGaussian'];
    },
    'next(I)I': (jvm, obj, args) => {
      const bits = args[0];
      let seed = obj['java/util/Random/seed'];
      seed = (seed * 0x5DEECE66Dn + 0xBn) & ((1n << 48n) - 1n);
      obj['java/util/Random/seed'] = seed;
      return Number(seed >> (48n - BigInt(bits)));
    },
    'nextBytes([B)V': (jvm, obj, args) => {
      if (!args[0]) {
        return;
      }
      const bytes = args[0];
      for (let i = 0; i < bytes.length; ) {
        const nextIntMethod = jvm._jreFindMethod('java/util/Random', 'nextInt', '()I');
        let rnd = nextIntMethod(jvm, obj, []);
        for (let n = Math.min(bytes.length - i, 4); n-- > 0; rnd >>= 8) {
          bytes[i++] = rnd & 0xff;
        }
      }
    },
    'nextInt()I': (jvm, obj, args) => {
      const nextMethod = jvm._jreFindMethod('java/util/Random', 'next', '(I)I');
      return nextMethod(jvm, obj, [32]);
    },
    'nextInt(I)I': (jvm, obj, args) => {
      const bound = args[0];
      if (bound <= 0) {
        const exception = {
          type: 'java/lang/IllegalArgumentException',
          message: 'bound must be positive',
        };
        throw exception;
      }
      if ((bound & -bound) === bound) { // i.e., bound is a power of 2
        const nextMethod = jvm._jreFindMethod('java/util/Random', 'next', '(I)I');
        const r = nextMethod(jvm, obj, [31]);
        return Number((BigInt(bound) * BigInt(r)) >> 31n);
      }
      let bits, val;
      do {
        const nextMethod = jvm._jreFindMethod('java/util/Random', 'next', '(I)I');
        bits = nextMethod(jvm, obj, [31]);
        val = bits % bound;
      } while (bits - val + (bound - 1) < 0);
      return val;
    },
    'nextLong()J': (jvm, obj, args) => {
      const nextMethod = jvm._jreFindMethod('java/util/Random', 'next', '(I)I');
      const high = BigInt(nextMethod(jvm, obj, [32]));
      const low = BigInt(nextMethod(jvm, obj, [32]));
      return (high << 32n) + low;
    },
    'nextBoolean()Z': (jvm, obj, args) => {
      const nextMethod = jvm._jreFindMethod('java/util/Random', 'next', '(I)I');
      return nextMethod(jvm, obj, [1]) !== 0;
    },
    'nextFloat()F': (jvm, obj, args) => {
      const nextMethod = jvm._jreFindMethod('java/util/Random', 'next', '(I)I');
      return nextMethod(jvm, obj, [24]) / (1 << 24);
    },
    'nextDouble()D': (jvm, obj, args) => {
      const nextMethod = jvm._jreFindMethod('java/util/Random', 'next', '(I)I');
      const high = BigInt(nextMethod(jvm, obj, [26]));
      const low = BigInt(nextMethod(jvm, obj, [27]));
      return Number(((high << 27n) + low)) / Number(1n << 53n);
    },
    'nextGaussian()D': (jvm, obj, args) => {
      if (obj['java/util/Random/haveNextNextGaussian']) {
        delete obj['java/util/Random/haveNextNextGaussian'];
        return obj['java/util/Random/nextNextGaussian'];
      }
      let v1, v2, s;
      do {
        const nextDoubleMethod = jvm._jreFindMethod('java/util/Random', 'nextDouble', '()D');
        v1 = 2 * nextDoubleMethod(jvm, obj, []) - 1;
        v2 = 2 * nextDoubleMethod(jvm, obj, []) - 1;
        s = v1 * v1 + v2 * v2;
      } while (s >= 1 || s === 0);
      const multiplier = Math.sqrt(-2 * Math.log(s) / s);
      obj['java/util/Random/nextNextGaussian'] = v2 * multiplier;
      obj['java/util/Random/haveNextNextGaussian'] = true;
      return v1 * multiplier;
    },
  },
};

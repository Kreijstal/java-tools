module.exports = {
  'java/util/Random': {
    '<init>()V': (thread, locals) => {
      const self = locals[0];
      self['java/util/Random/seed'] = Date.now();
      thread.return();
    },
    'nextInt()I': (thread, locals) => {
      const self = locals[0];
      let seed = self['java/util/Random/seed'];
      seed = (seed * 0x5DEECE66D + 0xB) & ((1 << 48) - 1);
      self['java/util/Random/seed'] = seed;
      thread.pushStack((seed >>> 16));
    },
    'nextGaussian()D': (thread, locals) => {
      const self = locals[0];
      let v1, v2, s;
      do {
        v1 = 2 * Math.random() - 1; // between -1 and 1
        v2 = 2 * Math.random() - 1; // between -1 and 1
        s = v1 * v1 + v2 * v2;
      } while (s >= 1 || s === 0);
      const multiplier = Math.sqrt(-2 * Math.log(s) / s);
      const nextNextGaussian = v2 * multiplier;
      self['java/util/Random/nextNextGaussian'] = nextNextGaussian;
      self['java/util/Random/haveNextNextGaussian'] = true;
      thread.pushStackDouble(v1 * multiplier);
    },
  },
};

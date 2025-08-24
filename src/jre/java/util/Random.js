module.exports = {
  'java/util/Random': {
    '<init>()V': (thread, locals) => {
      const self = locals[0];
      // Initialize with current time, similar to Java's default
      const seed = BigInt(Date.now()) & ((1n << 48n) - 1n);
      self['java/util/Random/seed'] = seed;
      thread.return();
    },
    '<init>(J)V': (thread, locals) => {
      const self = locals[0];
      const seedValue = locals[1];
      // Java's seed initialization: seed = (seed ^ 0x5DEECE66D) & ((1L << 48) - 1)
      self['java/util/Random/seed'] = (BigInt(seedValue) ^ 0x5DEECE66Dn) & ((1n << 48n) - 1n);
      thread.return();
    },
    'setSeed(J)V': (thread, locals) => {
      const self = locals[0];
      const seedValue = locals[1];
      // Java's seed initialization: seed = (seed ^ 0x5DEECE66D) & ((1L << 48) - 1)
      self['java/util/Random/seed'] = (BigInt(seedValue) ^ 0x5DEECE66Dn) & ((1n << 48n) - 1n);
      thread.return();
    },
    'nextInt()I': (thread, locals) => {
      const self = locals[0];
      let seed = self['java/util/Random/seed'];
      // Java's linear congruential generator: (a * seed + c) mod m
      // Where a = 0x5DEECE66D, c = 0xB, m = 2^48
      seed = (seed * 0x5DEECE66Dn + 0xBn) & ((1n << 48n) - 1n);
      self['java/util/Random/seed'] = seed;
      // Return upper 32 bits as signed integer
      const result = Number(seed >> 16n);
      // Convert to 32-bit signed integer
      return result | 0;
    },
    'nextInt(I)I': (thread, locals) => {
      const self = locals[0];
      const bound = locals[1];
      
      if (bound <= 0) {
        throw new Error('bound must be positive');
      }
      
      // Use the nextInt() method and apply modulo bound
      let seed = self['java/util/Random/seed'];
      seed = (seed * 0x5DEECE66Dn + 0xBn) & ((1n << 48n) - 1n);
      self['java/util/Random/seed'] = seed;
      
      const result = Number(seed >> 16n);
      const signedResult = result | 0;
      
      // Java's approach to ensure uniform distribution
      if ((bound & -bound) === bound) {
        // Power of 2 case
        const unsignedBound = bound >>> 0;
        return (signedResult >>> 0) % unsignedBound | 0;
      } else {
        // General case - use rejection method like Java does
        let val = signedResult >>> 1; // Use only 31 bits to ensure positive
        return val % bound;
      }
    },
    'nextLong()J': (thread, locals) => {
      const self = locals[0];
      let seed = self['java/util/Random/seed'];
      
      // Generate first 32 bits
      seed = (seed * 0x5DEECE66Dn + 0xBn) & ((1n << 48n) - 1n);
      const high32 = seed >> 16n;
      
      // Generate second 32 bits
      seed = (seed * 0x5DEECE66Dn + 0xBn) & ((1n << 48n) - 1n);
      const low32 = seed >> 16n;
      
      self['java/util/Random/seed'] = seed;
      
      // Combine into 64-bit long
      const result = (high32 << 32n) | (low32 & 0xFFFFFFFFn);
      return result;
    },
    'nextBoolean()Z': (thread, locals) => {
      const self = locals[0];
      let seed = self['java/util/Random/seed'];
      seed = (seed * 0x5DEECE66Dn + 0xBn) & ((1n << 48n) - 1n);
      self['java/util/Random/seed'] = seed;
      
      // Use one bit from the generated value
      return Number((seed >> 16n) & 1n);
    },
    'nextFloat()F': (thread, locals) => {
      const self = locals[0];
      let seed = self['java/util/Random/seed'];
      seed = (seed * 0x5DEECE66Dn + 0xBn) & ((1n << 48n) - 1n);
      self['java/util/Random/seed'] = seed;
      
      // Use upper 24 bits for float precision
      const intVal = Number(seed >> 24n);
      return intVal / (1 << 24); // Divide by 2^24 to get [0, 1)
    },
    'nextDouble()D': (thread, locals) => {
      const self = locals[0];
      let seed = self['java/util/Random/seed'];
      
      // Generate first 27 bits
      seed = (seed * 0x5DEECE66Dn + 0xBn) & ((1n << 48n) - 1n);
      const high27 = Number(seed >> 21n);
      
      // Generate second 26 bits  
      seed = (seed * 0x5DEECE66Dn + 0xBn) & ((1n << 48n) - 1n);
      const low26 = Number(seed >> 22n);
      
      self['java/util/Random/seed'] = seed;
      
      // Combine for 53 bits of precision
      return (high27 * (1 << 26) + low26) / (1 << 53);
    },
    'nextBytes([B)V': (thread, locals) => {
      const self = locals[0];
      const byteArray = locals[1];
      
      // Handle both array formats
      let bytes;
      if (byteArray && byteArray.array) {
        bytes = byteArray.array;
      } else if (Array.isArray(byteArray)) {
        bytes = byteArray;
      } else {
        throw new Error('Invalid byte array format');
      }
      
      let seed = self['java/util/Random/seed'];
      
      // Fill array with random bytes
      for (let i = 0; i < bytes.length; i++) {
        seed = (seed * 0x5DEECE66Dn + 0xBn) & ((1n << 48n) - 1n);
        // Use upper 8 bits of the 32-bit value
        const randomByte = Number((seed >> 40n) & 0xFFn);
        // Convert to signed byte (-128 to 127)
        bytes[i] = randomByte > 127 ? randomByte - 256 : randomByte;
      }
      
      self['java/util/Random/seed'] = seed;
      thread.return();
    },
    'nextGaussian()D': (thread, locals) => {
      const self = locals[0];
      
      // Check if we have a cached Gaussian value
      if (self['java/util/Random/haveNextNextGaussian']) {
        const cached = self['java/util/Random/nextNextGaussian'];
        self['java/util/Random/haveNextNextGaussian'] = false;
        return cached;
      }
      
      // Box-Muller transformation
      let v1, v2, s;
      do {
        // Generate two uniform random values in [-1, 1)
        v1 = 2 * self.nextDouble() - 1;
        v2 = 2 * self.nextDouble() - 1;
        s = v1 * v1 + v2 * v2;
      } while (s >= 1 || s === 0);
      
      const multiplier = Math.sqrt(-2 * Math.log(s) / s);
      const nextNextGaussian = v2 * multiplier;
      self['java/util/Random/nextNextGaussian'] = nextNextGaussian;
      self['java/util/Random/haveNextNextGaussian'] = true;
      
      return v1 * multiplier;
    },
  },
};

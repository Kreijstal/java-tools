// Arbitrary-precision integer backed by native BigInt. Byte arrays use Java's
// signed, big-endian, two's-complement convention (matching new
// BigInteger(byte[]) and toByteArray()). Byte arrays here are plain JS arrays
// of signed byte values tagged type '[B'.

function makeByteArray(bytes) {
  const arr = bytes.slice();
  arr.type = '[B';
  arr.elementType = 'byte';
  return arr;
}

// big-endian two's-complement signed byte[] -> BigInt
function fromSignedBytes(bytes) {
  if (!bytes || bytes.length === 0) return 0n;
  let v = 0n;
  for (let i = 0; i < bytes.length; i++) {
    v = (v << 8n) | BigInt(bytes[i] & 0xff);
  }
  const bits = BigInt(bytes.length * 8);
  const signBit = 1n << (bits - 1n);
  if (v & signBit) v -= 1n << bits; // negative
  return v;
}

// BigInt -> minimal big-endian two's-complement signed byte[] (Java toByteArray)
function toSignedBytes(v) {
  if (v === 0n) return [0];
  const bytes = [];
  if (v > 0n) {
    let t = v;
    while (t > 0n) { bytes.unshift(Number(t & 0xffn)); t >>= 8n; }
    if (bytes[0] & 0x80) bytes.unshift(0); // extra byte so sign bit stays clear
  } else {
    // Find a byte width large enough to hold v in two's complement.
    let len = 1;
    while (v < -(1n << BigInt(len * 8 - 1))) len++;
    let t = v + (1n << BigInt(len * 8)); // two's complement value
    for (let i = len - 1; i >= 0; i--) { bytes[i] = Number(t & 0xffn); t >>= 8n; }
    if (!(bytes[0] & 0x80)) bytes.unshift(0xff); // ensure sign bit set
  }
  // Convert to signed byte values (-128..127) to match Java byte semantics.
  return bytes.map((b) => (b << 24) >> 24);
}

function biValue(x) {
  if (x == null) return 0n;
  if (typeof x === 'bigint') return x;
  if (typeof x === 'number') return BigInt(Math.trunc(x));
  return x.value !== undefined ? x.value : 0n;
}

function wrap(value) {
  return { type: 'java/math/BigInteger', value };
}

function javaStringValue(str) {
  if (typeof str === 'string') return str;
  if (str && str.value !== undefined) return String(str.value);
  return String(str);
}

module.exports = {
  super: 'java/lang/Number',
  staticFields: {
    'ZERO:Ljava/math/BigInteger;': wrap(0n),
    'ONE:Ljava/math/BigInteger;': wrap(1n),
    'TEN:Ljava/math/BigInteger;': wrap(10n),
  },
  staticMethods: {
    'valueOf(J)Ljava/math/BigInteger;': (jvm, obj, args) => wrap(biValue(args[0])),
  },
  methods: {
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
      const s = javaStringValue(args[0]);
      try {
        obj.value = BigInt(s);
      } catch (e) {
        obj.value = 0n;
      }
    },
    '<init>(Ljava/lang/String;I)V': (jvm, obj, args) => {
      const s = javaStringValue(args[0]);
      const radix = Number(args[1]) || 10;
      try {
        if (radix === 10) obj.value = BigInt(s);
        else if (radix === 16) obj.value = BigInt('0x' + s);
        else if (radix === 8) obj.value = BigInt('0o' + s);
        else if (radix === 2) obj.value = BigInt('0b' + s);
        else {
          let v = 0n;
          const R = BigInt(radix);
          for (const ch of s.toLowerCase()) v = v * R + BigInt(parseInt(ch, radix));
          obj.value = v;
        }
      } catch (e) {
        obj.value = 0n;
      }
    },
    '<init>([B)V': (jvm, obj, args) => {
      obj.value = fromSignedBytes(args[0] || []);
    },
    '<init>(I[B)V': (jvm, obj, args) => {
      // (signum, magnitude big-endian unsigned)
      const signum = Number(args[0]);
      const mag = args[1] || [];
      let v = 0n;
      for (let i = 0; i < mag.length; i++) v = (v << 8n) | BigInt(mag[i] & 0xff);
      obj.value = signum < 0 ? -v : v;
    },
    'modPow(Ljava/math/BigInteger;Ljava/math/BigInteger;)Ljava/math/BigInteger;': (jvm, obj, args) => {
      const exp = biValue(args[0]);
      const mod = biValue(args[1]);
      if (mod === 0n) throw { type: 'java/lang/ArithmeticException', message: 'modulus not positive' };
      let result = 1n;
      let base = ((obj.value % mod) + mod) % mod;
      let e = exp;
      while (e > 0n) {
        if (e & 1n) result = (result * base) % mod;
        e >>= 1n;
        base = (base * base) % mod;
      }
      return wrap(result);
    },
    'modInverse(Ljava/math/BigInteger;)Ljava/math/BigInteger;': (jvm, obj, args) => {
      const m = biValue(args[0]);
      let [old_r, r] = [((obj.value % m) + m) % m, m];
      let [old_s, s] = [1n, 0n];
      while (r !== 0n) {
        const q = old_r / r;
        [old_r, r] = [r, old_r - q * r];
        [old_s, s] = [s, old_s - q * s];
      }
      return wrap(((old_s % m) + m) % m);
    },
    'multiply(Ljava/math/BigInteger;)Ljava/math/BigInteger;': (jvm, obj, args) => wrap(obj.value * biValue(args[0])),
    'add(Ljava/math/BigInteger;)Ljava/math/BigInteger;': (jvm, obj, args) => wrap(obj.value + biValue(args[0])),
    'subtract(Ljava/math/BigInteger;)Ljava/math/BigInteger;': (jvm, obj, args) => wrap(obj.value - biValue(args[0])),
    'mod(Ljava/math/BigInteger;)Ljava/math/BigInteger;': (jvm, obj, args) => {
      const m = biValue(args[0]);
      return wrap(((obj.value % m) + m) % m);
    },
    'pow(I)Ljava/math/BigInteger;': (jvm, obj, args) => wrap(obj.value ** BigInt(Number(args[0]))),
    'compareTo(Ljava/math/BigInteger;)I': (jvm, obj, args) => {
      const o = biValue(args[0]);
      return obj.value < o ? -1 : obj.value > o ? 1 : 0;
    },
    'equals(Ljava/lang/Object;)Z': (jvm, obj, args) => {
      const o = args[0];
      return o && o.type === 'java/math/BigInteger' && o.value === obj.value ? 1 : 0;
    },
    'signum()I': (jvm, obj) => (obj.value < 0n ? -1 : obj.value > 0n ? 1 : 0),
    'intValue()I': (jvm, obj) => Number(BigInt.asIntN(32, obj.value)),
    'longValue()J': (jvm, obj) => BigInt.asIntN(64, obj.value),
    'bitLength()I': (jvm, obj) => {
      const v = obj.value < 0n ? -obj.value - 1n : obj.value;
      return v === 0n ? 0 : v.toString(2).length;
    },
    'toByteArray()[B': (jvm, obj) => makeByteArray(toSignedBytes(obj.value)),
    'toString()Ljava/lang/String;': (jvm, obj) => jvm.internString(obj.value.toString()),
    'toString(I)Ljava/lang/String;': (jvm, obj, args) => jvm.internString(obj.value.toString(Number(args[0]) || 10)),
  },
};

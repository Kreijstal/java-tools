function bits(obj) {
  if (!(obj.bits instanceof Set)) obj.bits = new Set();
  return obj.bits;
}
function sourceBits(other) {
  if (!other) return new Set();
  if (other.bits instanceof Set) return other.bits;
  return new Set();
}
function sortedValues(set) { return Array.from(set).sort((a, b) => a - b); }

module.exports = {
  super: 'java/lang/Object',
  interfaces: ['java/lang/Cloneable', 'java/io/Serializable'],
  methods: {
    '<init>()V': (jvm, obj) => { obj.bits = new Set(); obj.bitCapacity = 64; },
    '<init>(I)V': (jvm, obj, args) => {
      obj.bits = new Set();
      obj.bitCapacity = Math.ceil(args[0] / 64) * 64;
    },
    'set(I)V': (jvm, obj, args) => {
      bits(obj).add(args[0]);
      obj.bitCapacity = Math.max(obj.bitCapacity || 0, Math.ceil((args[0] + 1) / 64) * 64);
    },
    'clear(I)V': (jvm, obj, args) => { bits(obj).delete(args[0]); },
    'get(I)Z': (jvm, obj, args) => bits(obj).has(args[0]) ? 1 : 0,
    'or(Ljava/util/BitSet;)V': (jvm, obj, args) => { const b = bits(obj); for (const v of sourceBits(args[0])) b.add(v); },
    'and(Ljava/util/BitSet;)V': (jvm, obj, args) => { const b = bits(obj); const o = sourceBits(args[0]); for (const v of Array.from(b)) if (!o.has(v)) b.delete(v); },
    'xor(Ljava/util/BitSet;)V': (jvm, obj, args) => { const b = bits(obj); for (const v of sourceBits(args[0])) { if (b.has(v)) b.delete(v); else b.add(v); } },
    'cardinality()I': (jvm, obj) => bits(obj).size,
    'size()I': (jvm, obj) => obj.bitCapacity || 0,
    'length()I': (jvm, obj) => {
      const values = sortedValues(bits(obj));
      return values.length === 0 ? 0 : values[values.length - 1] + 1;
    },
    'nextSetBit(I)I': (jvm, obj, args) => {
      const start = args[0];
      for (const v of sortedValues(bits(obj))) if (v >= start) return v;
      return -1;
    },
    'isEmpty()Z': (jvm, obj) => bits(obj).size === 0 ? 1 : 0,
    'clone()Ljava/lang/Object;': (jvm, obj) => ({ type: 'java/util/BitSet', bits: new Set(bits(obj)), hashCode: jvm.nextHashCode++ }),
    'equals(Ljava/lang/Object;)Z': (jvm, obj, args) => {
      const other = args[0];
      if (!other || other.type !== 'java/util/BitSet') return 0;
      const a = bits(obj);
      const b = sourceBits(other);
      if (a.size !== b.size) return 0;
      for (const v of a) if (!b.has(v)) return 0;
      return 1;
    },
    'hashCode()I': (jvm, obj) => {
      let h = 1234;
      for (const v of sortedValues(bits(obj))) h = ((h * 31) ^ v) | 0;
      return h;
    },
    'toString()Ljava/lang/String;': (jvm, obj) => `{${sortedValues(bits(obj)).join(', ')}}`,
  },
};

const HEAP = { type: 'java/lang/management/MemoryType', name: 'HEAP', ordinal: 0 };
const NON_HEAP = { type: 'java/lang/management/MemoryType', name: 'NON_HEAP', ordinal: 1 };

module.exports = {
  super: 'java/lang/Enum',
  staticFields: {
    'HEAP:Ljava/lang/management/MemoryType;': HEAP,
    'NON_HEAP:Ljava/lang/management/MemoryType;': NON_HEAP,
  },
  staticMethods: {
    'values()[Ljava/lang/management/MemoryType;': (jvm) => {
      const values = [HEAP, NON_HEAP];
      values.type = '[Ljava/lang/management/MemoryType;';
      values.elementType = 'java/lang/management/MemoryType';
      values.hashCode = jvm.nextHashCode++;
      return values;
    },
    'valueOf(Ljava/lang/String;)Ljava/lang/management/MemoryType;': (jvm, obj, args) => {
      const name = args[0] && Object.prototype.hasOwnProperty.call(args[0], 'value')
        ? String(args[0].value)
        : String(args[0]);
      if (name === 'HEAP') return HEAP;
      if (name === 'NON_HEAP') return NON_HEAP;
      throw { type: 'java/lang/IllegalArgumentException' };
    },
  },
};

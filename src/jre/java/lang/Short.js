function boxed(jvm, value) {
  const shortValue = (value << 16) >> 16;
  return {
    type: 'java/lang/Short',
    _className: 'java/lang/Short',
    value: shortValue,
    hashCode: jvm.nextHashCode++,
    toString() { return String(this.value); },
  };
}

module.exports = {
  super: 'java/lang/Number',
  staticFields: {
    'TYPE:Ljava/lang/Class;': {
      type: 'java/lang/Class',
      isPrimitive: true,
      name: 'short',
    },
    'MAX_VALUE:S': 32767,
    'MIN_VALUE:S': -32768,
  },
  staticMethods: {
    'valueOf(S)Ljava/lang/Short;': (jvm, obj, args) => boxed(jvm, args[0]),
    'valueOf(Ljava/lang/String;)Ljava/lang/Short;': (jvm, obj, args) => boxed(jvm, parseInt(args[0] && args[0].value !== undefined ? args[0].value : args[0], 10) || 0),
    'parseShort(Ljava/lang/String;)S': (jvm, obj, args) => (parseInt(args[0] && args[0].value !== undefined ? args[0].value : args[0], 10) || 0) << 16 >> 16,
    'toString(S)Ljava/lang/String;': (jvm, obj, args) => jvm.newString(String((args[0] << 16) >> 16)),
    'compare(SS)I': (jvm, obj, args) => args[0] < args[1] ? -1 : (args[0] > args[1] ? 1 : 0),
  },
  methods: {
    '<init>(S)V': (jvm, obj, args) => { Object.assign(obj, boxed(jvm, args[0])); },
    'shortValue()S': (jvm, obj) => obj.value << 16 >> 16,
    'intValue()I': (jvm, obj) => obj.value | 0,
    'longValue()J': (jvm, obj) => obj.value,
    'floatValue()F': (jvm, obj) => obj.value,
    'doubleValue()D': (jvm, obj) => obj.value,
    'byteValue()B': (jvm, obj) => obj.value << 24 >> 24,
    'equals(Ljava/lang/Object;)Z': (jvm, obj, args) => args[0] && args[0].type === 'java/lang/Short' && args[0].value === obj.value ? 1 : 0,
    'hashCode()I': (jvm, obj) => obj.value | 0,
    'toString()Ljava/lang/String;': (jvm, obj) => jvm.newString(String(obj.value)),
  },
};

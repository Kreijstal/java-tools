function boxed(jvm, value) {
  const byteValue = (value << 24) >> 24;
  return {
    type: 'java/lang/Byte',
    _className: 'java/lang/Byte',
    value: byteValue,
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
      name: 'byte',
    },
  },
  staticMethods: {
    'valueOf(B)Ljava/lang/Byte;': (jvm, obj, args) => boxed(jvm, args[0]),
    'valueOf(Ljava/lang/String;)Ljava/lang/Byte;': (jvm, obj, args) => boxed(jvm, parseInt(args[0] && args[0].value !== undefined ? args[0].value : args[0], 10) || 0),
    'parseByte(Ljava/lang/String;)B': (jvm, obj, args) => (parseInt(args[0] && args[0].value !== undefined ? args[0].value : args[0], 10) || 0) << 24 >> 24,
    'toString(B)Ljava/lang/String;': (jvm, obj, args) => jvm.newString(String((args[0] << 24) >> 24)),
    'compare(BB)I': (jvm, obj, args) => args[0] < args[1] ? -1 : (args[0] > args[1] ? 1 : 0),
  },
  methods: {
    '<init>(B)V': (jvm, obj, args) => { Object.assign(obj, boxed(jvm, args[0])); },
    'byteValue()B': (jvm, obj) => obj.value << 24 >> 24,
    'shortValue()S': (jvm, obj) => obj.value << 16 >> 16,
    'intValue()I': (jvm, obj) => obj.value | 0,
    'longValue()J': (jvm, obj) => obj.value,
    'floatValue()F': (jvm, obj) => obj.value,
    'doubleValue()D': (jvm, obj) => obj.value,
    'equals(Ljava/lang/Object;)Z': (jvm, obj, args) => args[0] && args[0].type === 'java/lang/Byte' && args[0].value === obj.value ? 1 : 0,
    'hashCode()I': (jvm, obj) => obj.value | 0,
    'toString()Ljava/lang/String;': (jvm, obj) => jvm.newString(String(obj.value)),
  },
};

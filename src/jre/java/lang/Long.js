module.exports = {
  super: 'java/lang/Number',
  staticFields: {
    'TYPE:Ljava/lang/Class;': {
      type: 'java/lang/Class',
      isPrimitive: true,
      name: 'long',
    },
    'MAX_VALUE:J': BigInt('9223372036854775807'),
    'MIN_VALUE:J': BigInt('-9223372036854775808'),
  },
  staticMethods: {
    'toString(J)Ljava/lang/String;': (jvm, obj, args) => {
      const value = typeof args[0] === 'bigint' ? args[0] : BigInt(args[0] || 0);
      return jvm.newString(value.toString());
    },
    'toString(JI)Ljava/lang/String;': (jvm, obj, args) => {
      const value = typeof args[0] === 'bigint' ? args[0] : BigInt(args[0] || 0);
      const radix = args[1] | 0;
      return jvm.newString(value.toString(radix >= 2 && radix <= 36 ? radix : 10));
    },
    'parseLong(Ljava/lang/String;)J': (jvm, obj, args) => {
      const str = args[0];
      // Handle both string objects and primitive strings
      const stringValue = (typeof str === 'string') ? str : (str && str.value ? str.value : str);
      if (!stringValue) return BigInt(0);
      try {
        const result = BigInt(stringValue);
        return result;
      } catch (error) {
        // In real Java this would throw NumberFormatException
        return BigInt(0);
      }
    },
    'sum(JJ)J': (jvm, obj, args) =>
      BigInt.asIntN(64, BigInt(args[0]) + BigInt(args[1])),
    'max(JJ)J': (jvm, obj, args) =>
      BigInt(args[0]) >= BigInt(args[1]) ? BigInt(args[0]) : BigInt(args[1]),
    'min(JJ)J': (jvm, obj, args) =>
      BigInt(args[0]) <= BigInt(args[1]) ? BigInt(args[0]) : BigInt(args[1]),
    'compare(JJ)I': (jvm, obj, args) =>
      BigInt(args[0]) < BigInt(args[1]) ? -1 :
        (BigInt(args[0]) > BigInt(args[1]) ? 1 : 0),
    'hashCode(J)I': (jvm, obj, args) => {
      const value = BigInt.asUintN(64, BigInt(args[0]));
      return Number(BigInt.asIntN(32, value ^ (value >> 32n)));
    },
    'valueOf(J)Ljava/lang/Long;': (jvm, obj, args) => {
      const longObj = {
        type: 'java/lang/Long',
        value: args[0],
      };
      
      longObj.toString = function() {
        return this.value.toString();
      };
      
      return longObj;
    },
  },
  methods: {
    '<init>(J)V': (jvm, obj, args) => {
      obj.value = args[0];
      
      obj.toString = function() {
        return this.value.toString();
      };
    },
    'longValue()J': (jvm, obj, args) => {
      return obj.value;
    },
    'toString()Ljava/lang/String;': (jvm, obj, args) => {
      return jvm.newString(obj.value.toString());
    },
  },
};

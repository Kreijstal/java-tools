module.exports = {
  super: 'java/lang/Number',
  staticFields: {
    'TYPE:Ljava/lang/Class;': {
      type: 'java/lang/Class',
      isPrimitive: true,
      name: 'int',
    },
  },
  staticMethods: {
    'toBinaryString(I)Ljava/lang/String;': (jvm, obj, args) => {
      const intValue = args[0];
      // Use unsigned right shift to get the 32-bit two's complement representation
      const binaryString = (intValue >>> 0).toString(2);
      return jvm.internString(binaryString);
    },
    'toString(I)Ljava/lang/String;': (jvm, obj, args) => {
      const intValue = args[0];
      // Per spec, this should be a new string, not an interned one.
      return jvm.newString(intValue.toString());
    },
    'parseInt(Ljava/lang/String;)I': (jvm, obj, args) => {
      const str = args[0];
      if (!str) return 0;
      // Handle both string objects and primitive strings
      const stringValue = (typeof str === 'string') ? str : (str && str.value ? str.value : str);
      if (!stringValue) return 0;
      const result = parseInt(stringValue, 10);
      if (isNaN(result)) {
        // In real Java this would throw NumberFormatException
        return 0;
      }
      return result;
    },
    'toHexString(I)Ljava/lang/String;': (jvm, obj, args) => {
      const intValue = args[0];
      const hexString = (intValue >>> 0).toString(16);
      return jvm.newString(hexString);
    },
    'signum(I)I': (jvm, obj, args) => args[0] > 0 ? 1 : (args[0] < 0 ? -1 : 0),
    'compare(II)I': (jvm, obj, args) => args[0] < args[1] ? -1 : (args[0] > args[1] ? 1 : 0),
    'compareUnsigned(II)I': (jvm, obj, args) => (args[0] >>> 0) < (args[1] >>> 0) ? -1 : ((args[0] >>> 0) > (args[1] >>> 0) ? 1 : 0),
    'bitCount(I)I': (jvm, obj, args) => { let v = args[0] >>> 0, c = 0; while (v) { v &= v - 1; c++; } return c; },
    'highestOneBit(I)I': (jvm, obj, args) => { let v = args[0] | 0; if (v === 0) return 0; v |= v >> 1; v |= v >> 2; v |= v >> 4; v |= v >> 8; v |= v >> 16; return v - (v >>> 1); },
    'lowestOneBit(I)I': (jvm, obj, args) => args[0] & -args[0],
    'valueOf(I)Ljava/lang/Integer;': (jvm, obj, args) => {
      const integerObj = {
        type: 'java/lang/Integer',
        value: args[0],
      };
      
      // Add JavaScript toString method for proper string concatenation
      integerObj.toString = function() {
        if (this.value === undefined || this.value === null) {
          console.error('Integer toString called with undefined/null value:', this);
          return 'null';
        }
        return this.value.toString();
      };
      
      return integerObj;
    },
  },
  methods: {
    '<init>(I)V': (jvm, obj, args) => {
      obj.value = args[0];
      
      // Add JavaScript toString method for proper string concatenation
      obj.toString = function() {
        return this.value.toString();
      };
    },
    'intValue()I': (jvm, obj, args) => {
      return obj.value;
    },
    'longValue()J': (jvm, obj, args) => obj.value,
    'floatValue()F': (jvm, obj, args) => obj.value,
    'doubleValue()D': (jvm, obj, args) => obj.value,
    'byteValue()B': (jvm, obj, args) => obj.value & 0xff,
    'shortValue()S': (jvm, obj, args) => obj.value & 0xffff,
    'equals(Ljava/lang/Object;)Z': (jvm, obj, args) => args[0] && args[0].type === 'java/lang/Integer' && args[0].value === obj.value ? 1 : 0,
    'hashCode()I': (jvm, obj, args) => obj.value | 0,
    'toString()Ljava/lang/String;': (jvm, obj, args) => {
      // Per spec, this should be a new string, not an interned one.
      return jvm.newString(obj.value.toString());
    },
    'getClass()Ljava/lang/Class;': (jvm, obj, args) => {
      return {
        type: 'java/lang/Class',
        className: 'java.lang.Integer',
        getSimpleName: function() {
          return jvm.internString('Integer');
        }
      };
    },
  },
};

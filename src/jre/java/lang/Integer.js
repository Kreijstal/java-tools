const { withThrows } = require('../../helpers');

function stringValue(value) {
  return typeof value === 'string' ? value : value && Object.prototype.hasOwnProperty.call(value, 'value') ? String(value.value) : String(value);
}

function parseJavaInt(value, radix) {
  const text = stringValue(value);
  if (radix < 2 || radix > 36 || text.length === 0) throw { type: 'java/lang/NumberFormatException' };
  let index = text[0] === '-' || text[0] === '+' ? 1 : 0;
  if (index === text.length) throw { type: 'java/lang/NumberFormatException' };
  for (; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const digit = code >= 48 && code <= 57 ? code - 48
      : code >= 65 && code <= 90 ? code - 65 + 10
        : code >= 97 && code <= 122 ? code - 97 + 10 : -1;
    if (digit < 0 || digit >= radix) throw { type: 'java/lang/NumberFormatException' };
  }
  const result = Number.parseInt(text, radix);
  if (!Number.isFinite(result) || result < -2147483648 || result > 2147483647) throw { type: 'java/lang/NumberFormatException' };
  return result | 0;
}

module.exports = {
  super: 'java/lang/Number',
  staticFields: {
    'TYPE:Ljava/lang/Class;': {
      type: 'java/lang/Class',
      isPrimitive: true,
      name: 'int',
    },
    'MAX_VALUE:I': 2147483647,
    'MIN_VALUE:I': -2147483648,
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
    'toString(II)Ljava/lang/String;': (jvm, obj, args) => {
      const intValue = args[0] | 0;
      const radix = args[1] | 0;
      const effectiveRadix = radix >= 2 && radix <= 36 ? radix : 10;
      return jvm.newString(intValue.toString(effectiveRadix));
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
    'parseInt(Ljava/lang/String;I)I': withThrows((jvm, obj, args) => parseJavaInt(args[0], args[1]), ['java/lang/NumberFormatException']),
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
    'valueOf(Ljava/lang/String;)Ljava/lang/Integer;': withThrows((jvm, obj, args) => ({
      type: 'java/lang/Integer',
      value: parseJavaInt(args[0], 10),
    }), ['java/lang/NumberFormatException']),
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

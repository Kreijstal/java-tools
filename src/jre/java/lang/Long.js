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

// Long's static helpers. Longs are BigInt; an uninitialized long may still
// arrive as Number 0.
const { withThrows } = require('../../helpers');
const big = (value) => typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value) || 0));
const unsigned = (value) => BigInt.asUintN(64, big(value));
const signed = (value) => BigInt.asIntN(64, value);
const text = (value) => typeof value === 'string' ? value
  : value && Object.prototype.hasOwnProperty.call(value, 'value') ? String(value.value) : String(value);

function numberFormat(input) {
  return { type: 'java/lang/NumberFormatException', message: `For input string: "${input}"` };
}

function parseJavaLong(value, radix) {
  if (value === null || value === undefined) {
    throw { type: 'java/lang/NumberFormatException', message: 'null' };
  }
  const input = text(value);
  if (radix < 2 || radix > 36 || input.length === 0) throw numberFormat(input);
  const negative = input[0] === '-';
  let index = negative || input[0] === '+' ? 1 : 0;
  if (index === input.length) throw numberFormat(input);
  let result = 0n;
  const base = BigInt(radix);
  for (; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    const digit = code >= 48 && code <= 57 ? code - 48
      : code >= 65 && code <= 90 ? code - 55
        : code >= 97 && code <= 122 ? code - 87 : -1;
    if (digit < 0 || digit >= radix) throw numberFormat(input);
    result = result * base + BigInt(digit);
    if (result > 9223372036854775808n) throw numberFormat(input);
  }
  if (negative) result = -result;
  if (result > 9223372036854775807n) throw numberFormat(input);
  return result;
}

function numberOfLeadingZeros(value) {
  const bits = unsigned(value);
  return bits === 0n ? 64 : 64 - bits.toString(2).length;
}

function numberOfTrailingZeros(value) {
  const bits = unsigned(value);
  if (bits === 0n) return 64;
  return (bits & -bits).toString(2).length - 1;
}

function bitCount(value) {
  let count = 0;
  for (const digit of unsigned(value).toString(2)) if (digit === '1') count += 1;
  return count;
}

function rotateLeft(value, distance) {
  const bits = unsigned(value), shift = BigInt(distance & 63);
  return signed((bits << shift) | (bits >> ((64n - shift) & 63n)));
}

const unsignedText = (value, radix) => (jvm, obj, args) => jvm.newString(unsigned(args[0]).toString(radix));

Object.assign(module.exports.staticMethods, {
  'parseLong(Ljava/lang/String;)J': withThrows((jvm, obj, args) => parseJavaLong(args[0], 10),
    ['java/lang/NumberFormatException']),
  'parseLong(Ljava/lang/String;I)J': withThrows((jvm, obj, args) => parseJavaLong(args[0], args[1]),
    ['java/lang/NumberFormatException']),
  'valueOf(Ljava/lang/String;)Ljava/lang/Long;': withThrows((jvm, obj, args) =>
    module.exports.staticMethods['valueOf(J)Ljava/lang/Long;'](jvm, null, [parseJavaLong(args[0], 10)]),
  ['java/lang/NumberFormatException']),
  'signum(J)I': (jvm, obj, args) => { const v = big(args[0]); return v > 0n ? 1 : v < 0n ? -1 : 0; },
  'numberOfLeadingZeros(J)I': (jvm, obj, args) => numberOfLeadingZeros(args[0]),
  'numberOfTrailingZeros(J)I': (jvm, obj, args) => numberOfTrailingZeros(args[0]),
  'bitCount(J)I': (jvm, obj, args) => bitCount(args[0]),
  'highestOneBit(J)J': (jvm, obj, args) => {
    const bits = unsigned(args[0]);
    return bits === 0n ? 0n : signed(1n << BigInt(bits.toString(2).length - 1));
  },
  'lowestOneBit(J)J': (jvm, obj, args) => { const v = big(args[0]); return signed(v & -v); },
  'rotateLeft(JI)J': (jvm, obj, args) => rotateLeft(args[0], args[1]),
  'rotateRight(JI)J': (jvm, obj, args) => rotateLeft(args[0], -args[1]),
  'reverse(J)J': (jvm, obj, args) =>
    signed(BigInt('0b' + unsigned(args[0]).toString(2).padStart(64, '0').split('').reverse().join(''))),
  'reverseBytes(J)J': (jvm, obj, args) => {
    let bits = unsigned(args[0]), result = 0n;
    for (let i = 0; i < 8; i += 1) { result = (result << 8n) | (bits & 0xffn); bits >>= 8n; }
    return signed(result);
  },
  'compareUnsigned(JJ)I': (jvm, obj, args) => {
    const a = unsigned(args[0]), b = unsigned(args[1]);
    return a < b ? -1 : a > b ? 1 : 0;
  },
  // The JDK divides through BigInteger unless both operands are positive
  // (dividend alone for division), and its message says so.
  'divideUnsigned(JJ)J': withThrows((jvm, obj, args) => {
    const divisor = unsigned(args[1]);
    if (divisor === 0n) {
      throw { type: 'java/lang/ArithmeticException', message: big(args[0]) > 0n ? '/ by zero' : 'BigInteger divide by zero' };
    }
    return signed(unsigned(args[0]) / divisor);
  }, ['java/lang/ArithmeticException']),
  'remainderUnsigned(JJ)J': withThrows((jvm, obj, args) => {
    const divisor = unsigned(args[1]);
    if (divisor === 0n) throw { type: 'java/lang/ArithmeticException', message: 'BigInteger divide by zero' };
    return signed(unsigned(args[0]) % divisor);
  }, ['java/lang/ArithmeticException']),
  'toHexString(J)Ljava/lang/String;': unsignedText(null, 16),
  'toBinaryString(J)Ljava/lang/String;': unsignedText(null, 2),
  'toOctalString(J)Ljava/lang/String;': unsignedText(null, 8),
  'toUnsignedString(J)Ljava/lang/String;': unsignedText(null, 10),
});

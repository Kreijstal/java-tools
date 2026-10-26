const { toInt, toLong } = require('../../../core/javaNumeric');
const { withThrows } = require('../../helpers');


// Math.round: the closest integer, ties toward positive infinity (JS
// Math.round is exact), saturated to the result type; NaN is 0.
function roundDoubleToLong(value) {
  return toLong(Math.round(value));
}

function roundFloatToInt(value) {
  return toInt(Math.round(value));
}

function absLong(value) {
  return value < 0 ? BigInt.asIntN(64, -BigInt(value)) : value;
}

const MathClass = {
  super: 'java/lang/Object',
  staticFields: {
    'PI:D': Math.PI,
    'E:D': Math.E,
  },
  staticMethods: {
    'max(II)I': (jvm, obj, args) => {
      return Math.max(args[0], args[1]);
    },
    'max(JJ)J': (jvm, obj, args) => args[0] > args[1] ? args[0] : args[1],
    'max(FF)F': (jvm, obj, args) => Math.max(args[0], args[1]),
    'max(DD)D': (jvm, obj, args) => Math.max(args[0], args[1]),
    'min(II)I': (jvm, obj, args) => {
      return Math.min(args[0], args[1]);
    },
    'min(JJ)J': (jvm, obj, args) => args[0] < args[1] ? args[0] : args[1],
    'min(FF)F': (jvm, obj, args) => Math.min(args[0], args[1]),
    'min(DD)D': (jvm, obj, args) => Math.min(args[0], args[1]),
    'pow(DD)D': (jvm, obj, args) => {
      return Math.pow(args[0], args[1]);
    },
    'atan2(DD)D': (jvm, obj, args) => {
      return Math.atan2(args[0], args[1]);
    },
    'atan(D)D': (jvm, obj, args) => Math.atan(args[0]),
    'sin(D)D': (jvm, obj, args) => {
      return Math.sin(args[0]);
    },
    'cos(D)D': (jvm, obj, args) => {
      return Math.cos(args[0]);
    },
    'acos(D)D': (jvm, obj, args) => Math.acos(args[0]),
    'asin(D)D': (jvm, obj, args) => Math.asin(args[0]),
    'tan(D)D': (jvm, obj, args) => Math.tan(args[0]),
    'exp(D)D': (jvm, obj, args) => {
      return Math.exp(args[0]);
    },
    'log(D)D': (jvm, obj, args) => Math.log(args[0]),
    'rint(D)D': (jvm, obj, args) => {
      const value = args[0];
      const floor = Math.floor(value);
      const fraction = value - floor;
      if (fraction < 0.5) return floor;
      if (fraction > 0.5) return floor + 1;
      return floor % 2 === 0 ? floor : floor + 1;
    },
    'floor(D)D': (jvm, obj, args) => {
      return Math.floor(args[0]);
    },
    'sqrt(D)D': (jvm, obj, args) => {
      return Math.sqrt(args[0]);
    },
    // abs(MIN_VALUE) is MIN_VALUE: the negation wraps.
    'abs(I)I': (jvm, obj, args) => Math.abs(args[0]) | 0,
    'abs(J)J': (jvm, obj, args) => absLong(args[0]),
    'abs(F)F': (jvm, obj, args) => Math.abs(args[0]),
    'abs(D)D': (jvm, obj, args) => Math.abs(args[0]),
    'ceil(D)D': (jvm, obj, args) => {
      return Math.ceil(args[0]);
    },
    'round(F)I': (jvm, obj, args) => roundFloatToInt(args[0]),
    'round(D)J': (jvm, obj, args) => {
      return roundDoubleToLong(args[0]);
    },
    'random()D': (jvm, obj, args) => {
      return jvm.clock.random();
    },
  },
  methods: {},
};

// Pure JRE leaves publish their positional implementations to the generic
// compiler. This metadata belongs to the library implementation: codegen does
// not need a java/lang/Math name table and still guards static initialization
// before entering one of these functions.
const directStaticIntrinsics = {
  'max(II)I': Math.max,
  'max(JJ)J': (left, right) => left > right ? left : right,
  'max(FF)F': Math.max,
  'max(DD)D': Math.max,
  'min(II)I': Math.min,
  'min(JJ)J': (left, right) => left < right ? left : right,
  'min(FF)F': Math.min,
  'min(DD)D': Math.min,
  'pow(DD)D': Math.pow,
  'atan2(DD)D': Math.atan2,
  'atan(D)D': Math.atan,
  'sin(D)D': Math.sin,
  'cos(D)D': Math.cos,
  'acos(D)D': Math.acos,
  'asin(D)D': Math.asin,
  'tan(D)D': Math.tan,
  'exp(D)D': Math.exp,
  'log(D)D': Math.log,
  'rint(D)D': (value) => MathClass.staticMethods['rint(D)D'](
    null, null, [value]),
  'floor(D)D': Math.floor,
  'sqrt(D)D': Math.sqrt,
  'abs(I)I': (value) => Math.abs(value) | 0,
  'abs(J)J': absLong,
  'abs(F)F': Math.abs,
  'abs(D)D': Math.abs,
  'ceil(D)D': Math.ceil,
  'round(F)I': roundFloatToInt,
  'round(D)J': roundDoubleToLong,
};

for (const [signature, intrinsic] of Object.entries(directStaticIntrinsics)) {
  const method = MathClass.staticMethods[signature];
  method.jvmDirectFinal = true;
  method.jvmDirectIntrinsic = intrinsic;
  // Direct-intrinsic lowering must carry its heap effects just like a
  // bytecode callee.  Every implementation in this table is a pure scalar
  // operation, so callers may retain unrelated instance-field read caches.
  // An intrinsic without this explicit metadata remains fully conservative.
  method.jvmDirectFieldWriteKeys = Object.freeze([]);
}

// Integer helpers with Java's exact semantics: floor division, and the
// *Exact family that throws ArithmeticException on overflow.
const big = (value) => typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value) || 0));
const divideByZero = () => ({ type: 'java/lang/ArithmeticException', message: '/ by zero' });
const overflow = (kind) => ({ type: 'java/lang/ArithmeticException', message: `${kind} overflow` });
const ARITHMETIC = ['java/lang/ArithmeticException'];

function floorDivLong(x, y) {
  x = big(x); y = big(y);
  if (y === 0n) throw divideByZero();
  let q = x / y;
  if ((x % y !== 0n) && ((x < 0n) !== (y < 0n))) q -= 1n;
  return BigInt.asIntN(64, q);
}

function floorModLong(x, y) {
  x = big(x); y = big(y);
  if (y === 0n) throw divideByZero();
  const r = x % y;
  return r !== 0n && ((r < 0n) !== (y < 0n)) ? r + y : r;
}

function floorDivInt(x, y) {
  if ((y | 0) === 0) throw divideByZero();
  return Math.floor(x / y) | 0;
}

function floorModInt(x, y) {
  if ((y | 0) === 0) throw divideByZero();
  const r = x % y;
  return (r !== 0 && ((r < 0) !== (y < 0)) ? r + y : r) | 0;
}

function exactInt(value, kind) {
  if (value > 2147483647 || value < -2147483648) throw overflow(kind);
  return value;
}

function exactLong(value, kind) {
  if (value !== BigInt.asIntN(64, value)) throw overflow(kind);
  return value;
}

function signum(value) {
  return value > 0 ? 1 : value < 0 ? -1 : value;
}

function ulp(value, mantissaBits, minExponent, maxValue, float) {
  const magnitude = Math.abs(value);
  if (magnitude !== magnitude) return NaN;
  if (magnitude === Infinity) return Infinity;
  if (magnitude === maxValue) return float ? Math.fround(2 ** 104) : 2 ** 971;
  const exponent = magnitude === 0 ? minExponent : Math.max(minExponent, Math.floor(Math.log2(magnitude)));
  // log2 can be off by one at a power of two's boundary.
  const e = 2 ** exponent > magnitude ? exponent - 1 : 2 ** (exponent + 1) <= magnitude ? exponent + 1 : exponent;
  return 2 ** (Math.max(minExponent, e) - mantissaBits);
}

Object.assign(MathClass.staticMethods, {
  'floorDiv(JJ)J': withThrows((jvm, obj, args) => floorDivLong(args[0], args[1]), ARITHMETIC),
  'floorDiv(JI)J': withThrows((jvm, obj, args) => floorDivLong(args[0], args[1]), ARITHMETIC),
  'floorDiv(II)I': withThrows((jvm, obj, args) => floorDivInt(args[0], args[1]), ARITHMETIC),
  'floorMod(JJ)J': withThrows((jvm, obj, args) => floorModLong(args[0], args[1]), ARITHMETIC),
  'floorMod(JI)I': withThrows((jvm, obj, args) => Number(floorModLong(args[0], args[1])), ARITHMETIC),
  'floorMod(II)I': withThrows((jvm, obj, args) => floorModInt(args[0], args[1]), ARITHMETIC),
  'addExact(II)I': withThrows((jvm, obj, args) => exactInt(args[0] + args[1], 'integer'), ARITHMETIC),
  'subtractExact(II)I': withThrows((jvm, obj, args) => exactInt(args[0] - args[1], 'integer'), ARITHMETIC),
  'multiplyExact(II)I': withThrows((jvm, obj, args) => exactInt(args[0] * args[1], 'integer'), ARITHMETIC),
  'incrementExact(I)I': withThrows((jvm, obj, args) => exactInt(args[0] + 1, 'integer'), ARITHMETIC),
  'decrementExact(I)I': withThrows((jvm, obj, args) => exactInt(args[0] - 1, 'integer'), ARITHMETIC),
  'negateExact(I)I': withThrows((jvm, obj, args) => exactInt(-args[0], 'integer'), ARITHMETIC),
  'addExact(JJ)J': withThrows((jvm, obj, args) => exactLong(big(args[0]) + big(args[1]), 'long'), ARITHMETIC),
  'subtractExact(JJ)J': withThrows((jvm, obj, args) => exactLong(big(args[0]) - big(args[1]), 'long'), ARITHMETIC),
  'multiplyExact(JJ)J': withThrows((jvm, obj, args) => exactLong(big(args[0]) * big(args[1]), 'long'), ARITHMETIC),
  'incrementExact(J)J': withThrows((jvm, obj, args) => exactLong(big(args[0]) + 1n, 'long'), ARITHMETIC),
  'decrementExact(J)J': withThrows((jvm, obj, args) => exactLong(big(args[0]) - 1n, 'long'), ARITHMETIC),
  'negateExact(J)J': withThrows((jvm, obj, args) => exactLong(-big(args[0]), 'long'), ARITHMETIC),
  'toIntExact(J)I': withThrows((jvm, obj, args) => {
    const value = big(args[0]);
    if (value !== BigInt.asIntN(32, value)) throw overflow('integer');
    return Number(value);
  }, ARITHMETIC),
  'signum(D)D': (jvm, obj, args) => signum(args[0]),
  'signum(F)F': (jvm, obj, args) => signum(args[0]),
  'copySign(DD)D': (jvm, obj, args) => {
    const negative = args[1] < 0 || Object.is(args[1], -0);
    return negative ? -Math.abs(args[0]) : Math.abs(args[0]);
  },
  'copySign(FF)F': (jvm, obj, args) => {
    const negative = args[1] < 0 || Object.is(args[1], -0);
    return Math.fround(negative ? -Math.abs(args[0]) : Math.abs(args[0]));
  },
  'ulp(D)D': (jvm, obj, args) => ulp(args[0], 52, -1022, Number.MAX_VALUE, false),
  'ulp(F)F': (jvm, obj, args) => Math.fround(ulp(Math.fround(args[0]), 23, -126, 3.4028234663852886e38, true)),
  'log10(D)D': (jvm, obj, args) => Math.log10(args[0]),
  'log1p(D)D': (jvm, obj, args) => Math.log1p(args[0]),
  'expm1(D)D': (jvm, obj, args) => Math.expm1(args[0]),
  'cbrt(D)D': (jvm, obj, args) => Math.cbrt(args[0]),
  'hypot(DD)D': (jvm, obj, args) => Math.hypot(args[0], args[1]),
  'sinh(D)D': (jvm, obj, args) => Math.sinh(args[0]),
  'cosh(D)D': (jvm, obj, args) => Math.cosh(args[0]),
  'tanh(D)D': (jvm, obj, args) => Math.tanh(args[0]),
  // Java 8's formulas (Java 9 multiplies by a precomputed constant).
  'toRadians(D)D': (jvm, obj, args) => args[0] / 180.0 * Math.PI,
  'toDegrees(D)D': (jvm, obj, args) => args[0] * 180.0 / Math.PI,
});

module.exports = MathClass;


const LONG_MIN_VALUE = -9223372036854775808n;
const LONG_MAX_VALUE = 9223372036854775807n;
const LONG_EXCLUSIVE_UPPER_BOUND = 2 ** 63;

function roundDoubleToLong(value) {
  // Java specifies Math.round(double) as (long)floor(value + 0.5d).  The
  // floating-to-long conversion saturates infinities and out-of-range finite
  // values, while NaN converts to zero.  JVM longs are represented as BigInt.
  const rounded = Math.floor(value + 0.5);
  if (Number.isNaN(rounded)) return 0n;
  if (rounded >= LONG_EXCLUSIVE_UPPER_BOUND) return LONG_MAX_VALUE;
  if (rounded <= -LONG_EXCLUSIVE_UPPER_BOUND) return LONG_MIN_VALUE;
  return BigInt(rounded);
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
    'abs(I)I': (jvm, obj, args) => {
      return Math.abs(args[0]);
    },
    'abs(J)J': (jvm, obj, args) => args[0] < 0 ? -args[0] : args[0],
    'abs(F)F': (jvm, obj, args) => Math.abs(args[0]),
    'abs(D)D': (jvm, obj, args) => Math.abs(args[0]),
    'ceil(D)D': (jvm, obj, args) => {
      return Math.ceil(args[0]);
    },
    'round(F)I': (jvm, obj, args) => {
      return Math.round(args[0]);
    },
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
  'abs(I)I': Math.abs,
  'abs(J)J': (value) => value < 0 ? -value : value,
  'abs(F)F': Math.abs,
  'abs(D)D': Math.abs,
  'ceil(D)D': Math.ceil,
  'round(F)I': Math.round,
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

module.exports = MathClass;

const fakeClock = require('../../../core/fakeClock');

module.exports = {
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
    'random()D': (jvm, obj, args) => {
      if (fakeClock.enabled) return fakeClock.random();
      return Math.random();
    },
  },
  methods: {},
};

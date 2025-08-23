module.exports = {
  super: 'java/lang/Object',
  staticFields: {},
  staticMethods: {
    'max(II)I': (jvm, obj, args) => {
      return Math.max(args[0], args[1]);
    },
    'min(II)I': (jvm, obj, args) => {
      return Math.min(args[0], args[1]);
    },
    'pow(DD)D': (jvm, obj, args) => {
      return Math.pow(args[0], args[1]);
    },
    'atan2(DD)D': (jvm, obj, args) => {
      return Math.atan2(args[0], args[1]);
    },
    'sin(D)D': (jvm, obj, args) => {
      return Math.sin(args[0]);
    },
    'cos(D)D': (jvm, obj, args) => {
      return Math.cos(args[0]);
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
    'ceil(D)D': (jvm, obj, args) => {
      return Math.ceil(args[0]);
    },
    'round(F)I': (jvm, obj, args) => {
      return Math.round(args[0]);
    },
    'random()D': (jvm, obj, args) => {
      return Math.random();
    },
  },
  methods: {},
};
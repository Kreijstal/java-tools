module.exports = {
  super: "java/lang/Object",
  interfaces: [],
  staticFields: {},
  staticMethods: {},
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj._date = new Date();
    },
    '<init>(J)V': (jvm, obj, args) => {
      obj.time = args[0];
      obj._date = new Date(Number(args[0]));
    },
    'getTime()J': (jvm, obj) => obj.time === undefined ? BigInt(obj._date.getTime()) : BigInt(obj.time),
 'getYear()I': (jvm, obj, args) => {
      return obj._date.getFullYear() - 1900;
    },
  },
};

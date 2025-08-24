module.exports = {
  super: "java/lang/Object",
  interfaces: [],
  staticFields: {},
  staticMethods: {},
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj._date = new Date();
    },
    'getYear()I': (jvm, obj, args) => {
      return obj._date.getFullYear() - 1900;
    },
  },
};

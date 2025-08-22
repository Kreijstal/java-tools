module.exports = {
  super: 'java/lang/IndexOutOfBoundsException',
  staticFields: {},
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.message = jvm.internString('String index out of range');
      obj.cause = null;
      obj.suppressedExceptions = [];
    },
    '<init>(I)V': (jvm, obj, args) => {
      const index = args[0];
      obj.message = jvm.internString(`String index out of range: ${index}`);
      obj.cause = null;
      obj.suppressedExceptions = [];
    },
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj.message = args[0];
      obj.cause = null;
      obj.suppressedExceptions = [];
    },
  },
};

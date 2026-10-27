module.exports = {
  super: 'java/lang/RuntimeException',
  staticFields: {},
  methods: {
    '<init>()V': (jvm, obj) => {
      obj.message = null;
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

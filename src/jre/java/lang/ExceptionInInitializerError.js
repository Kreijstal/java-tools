// What a static initializer's exception becomes when it is not an Error: the
// cause is the exception itself.
module.exports = {
  super: 'java/lang/LinkageError',
  methods: {
    '<init>()V': (jvm, obj) => {
      obj.message = null;
      obj.cause = null;
    },
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj.message = args[0];
      obj.cause = null;
    },
    '<init>(Ljava/lang/Throwable;)V': (jvm, obj, args) => {
      obj.message = null;
      obj.cause = args[0];
    },
    'getException()Ljava/lang/Throwable;': (jvm, obj) => obj.cause,
    'getCause()Ljava/lang/Throwable;': (jvm, obj) => obj.cause,
  },
};

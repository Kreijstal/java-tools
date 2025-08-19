module.exports = {
  super: 'java/lang/Exception',
  staticFields: {},
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.message = null;
      obj.cause = null;
      obj.suppressedExceptions = [];
    },
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj.message = args[0];
      obj.cause = null;
      obj.suppressedExceptions = [];
    },
    'getMessage()Ljava/lang/String;': (jvm, obj, args) => {
      return obj.message;
    },
    'toString()Ljava/lang/String;': (jvm, obj, args) => {
      const message = obj.message;
      const className = obj.type.replace(/\//g, '.');
      if (message) {
        return jvm.internString(`${className}: ${message.value}`);
      } else {
        return jvm.internString(className);
      }
    },
    'addSuppressed(Ljava/lang/Throwable;)V': (jvm, obj, args) => {
      const suppressedException = args[0];
      if (!obj.suppressedExceptions) {
        obj.suppressedExceptions = [];
      }
      obj.suppressedExceptions.push(suppressedException);
    },
    'getSuppressed()[Ljava/lang/Throwable;': (jvm, obj, args) => {
      const suppressedArray = obj.suppressedExceptions || [];
      // Create a Java array of Throwable
      const javaArray = {
        type: '[Ljava/lang/Throwable;',
        length: suppressedArray.length,
        elements: suppressedArray
      };
      return javaArray;
    },
  },
};
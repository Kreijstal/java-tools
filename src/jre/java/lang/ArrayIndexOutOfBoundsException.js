module.exports = {
  super: 'java/lang/RuntimeException',
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
    '<init>(I)V': (jvm, obj, args) => {
      const index = args[0];
      obj.message = jvm.internString(`Index ${index} out of bounds`);
      obj.cause = null;
      obj.suppressedExceptions = [];
    },
    'getMessage()Ljava/lang/String;': (jvm, obj, args) => {
      return obj.message;
    },
    'getClass()Ljava/lang/Class;': (jvm, obj, args) => {
      // Return a Class object representing ArrayIndexOutOfBoundsException
      return {
        type: 'java/lang/Class',
        className: 'java.lang.ArrayIndexOutOfBoundsException',
        getSimpleName: function() {
          return jvm.internString('ArrayIndexOutOfBoundsException');
        }
      };
    },
    'toString()Ljava/lang/String;': (jvm, obj, args) => {
      const message = obj.message;
      const className = 'java.lang.ArrayIndexOutOfBoundsException';
      if (message && message.value) {
        return jvm.internString(`${className}: ${message.value}`);
      } else {
        return jvm.internString(className);
      }
    },
  },
};
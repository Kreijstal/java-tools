module.exports = {
  super: 'java/lang/RuntimeException',
  staticFields: {},
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.message = jvm.internString('null');
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
    'getClass()Ljava/lang/Class;': (jvm, obj, args) => {
      // Return a Class object representing NullPointerException
      return {
        type: 'java/lang/Class',
        className: 'java.lang.NullPointerException',
        getSimpleName: function() {
          return jvm.internString('NullPointerException');
        }
      };
    },
    'toString()Ljava/lang/String;': (jvm, obj, args) => {
      const message = obj.message;
      const className = 'java.lang.NullPointerException';
      if (message && message.value) {
        return jvm.internString(`${className}: ${message.value}`);
      } else {
        return jvm.internString(className);
      }
    },
  },
};
module.exports = {
  super: 'java/lang/Object',
  staticFields: {},
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.message = null;
      obj.cause = null;
      obj.stackTrace = [];
    },
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj.message = args[0];
      obj.cause = null;
      obj.stackTrace = [];
    },
    '<init>(Ljava/lang/String;Ljava/lang/Throwable;)V': (jvm, obj, args) => {
      obj.message = args[0];
      obj.cause = args[1];
      obj.stackTrace = [];
    },
    'getMessage()Ljava/lang/String;': (jvm, obj, args) => {
      return obj.message;
    },
    'getCause()Ljava/lang/Throwable;': (jvm, obj, args) => {
      return obj.cause;
    },
    'toString()Ljava/lang/String;': (jvm, obj, args) => {
      const message = obj.message;
      const className = obj.type.replace(/\//g, '.');
      if (message) {
        return jvm.internString(`${className}: ${message}`);
      } else {
        return jvm.internString(className);
      }
    },
    'printStackTrace()V': (jvm, obj, args) => {
      const className = obj.type.replace(/\//g, '.');
      const message = obj.message;
      if (message) {
        console.error(`${className}: ${message}`);
      } else {
        console.error(className);
      }
      // In a real implementation, this would print the full stack trace
      console.error('\tat <native method>');
    },
  },
};
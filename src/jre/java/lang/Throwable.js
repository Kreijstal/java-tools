module.exports = {
  super: 'java/lang/Object',
  staticFields: {},
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.message = null;
      obj.cause = null;
      obj.stackTrace = [];
      obj.suppressedExceptions = [];
    },
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj.message = args[0];
      obj.cause = null;
      obj.stackTrace = [];
      obj.suppressedExceptions = [];
    },
    '<init>(Ljava/lang/String;Ljava/lang/Throwable;)V': (jvm, obj, args) => {
      obj.message = args[0];
      obj.cause = args[1];
      obj.stackTrace = [];
      obj.suppressedExceptions = [];
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
        return jvm.internString(`${className}: ${message.value}`);
      } else {
        return jvm.internString(className);
      }
    },
    'printStackTrace()V': (jvm, obj, args) => {
      const className = obj.type.replace(/\//g, '.');
      const message = obj.message;
      if (message) {
        console.error(`${className}: ${message.value}`);
      } else {
        console.error(className);
      }
      // In a real implementation, this would print the full stack trace
      console.error('\tat <native method>');
    },
    'printStackTrace(Ljava/io/PrintWriter;)V': (jvm, obj, args) => {
      const printWriter = args[0];
      const className = obj.type.replace(/\//g, '.');
      const message = obj.message;
      
      // Create the error message
      let errorMsg;
      if (message) {
        errorMsg = `${className}: ${message.value}`;
      } else {
        errorMsg = className;
      }
      
      // Write to PrintWriter - simplified implementation
      if (printWriter && printWriter.println) {
        printWriter.println(errorMsg);
        printWriter.println('\tat <native method>');
      } else {
        // Fallback to console if PrintWriter doesn't have expected methods
        console.error(errorMsg);
        console.error('\tat <native method>');
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
    'getClass()Ljava/lang/Class;': (jvm, obj, args) => {
      // Extract class name from the object's type
      const className = obj.type.replace(/\//g, '.');
      const shortName = className.split('.').pop();
      
      return {
        type: 'java/lang/Class',
        className: className,
        getSimpleName: function() {
          return jvm.internString(shortName);
        }
      };
    },
  },
};
function javaString(value) {
  if (value === null || value === undefined) return null;
  if (value && value.type === 'java/lang/String' && Object.prototype.hasOwnProperty.call(value, 'value')) return value;
  if (value && Object.prototype.hasOwnProperty.call(value, 'value')) return value;
  return null;
}

function throwableMessage(jvm, throwable) {
  if (!throwable) return null;
  if (throwable.message) return throwable.message;
  const className = String(throwable.type || throwable.constructor && throwable.constructor.name || 'java/lang/Throwable').replace(/\//g, '.');
  return jvm.internString(className);
}

function messageValue(message) {
  if (message === null || message === undefined) return '';
  if (message && Object.prototype.hasOwnProperty.call(message, 'value')) return String(message.value);
  return String(message);
}

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
        return jvm.internString(`${className}: ${messageValue(message)}`);
      } else {
        return jvm.internString(className);
      }
    },
    'printStackTrace()V': (jvm, obj, args) => {
      const className = obj.type.replace(/\//g, '.');
      const message = obj.message;
      if (message) {
        console.error(`${className}: ${messageValue(message)}`);
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
        errorMsg = `${className}: ${messageValue(message)}`;
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
    'getStackTrace()[Ljava/lang/StackTraceElement;': (jvm, obj) => {
      const array = obj.stackTrace || [];
      array.type = '[Ljava/lang/StackTraceElement;';
      array.elementType = 'java/lang/StackTraceElement';
      array.length = array.length;
      return array;
    },
    'fillInStackTrace()Ljava/lang/Throwable;': (jvm, obj) => {
      if (!obj.stackTrace) obj.stackTrace = [];
      return obj;
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
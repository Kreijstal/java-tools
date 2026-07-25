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
    '<init>(Ljava/lang/Throwable;)V': (jvm, obj, args) => {
      obj.message = throwableMessage(jvm, args[0]);
      obj.cause = args[0];
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
    'toString()Ljava/lang/String;': (jvm, obj, args) => {
      const message = obj.message;
      const className = obj.type.replace(/\//g, '.');
      if (message) {
        return jvm.internString(`${className}: ${messageValue(message)}`);
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
function messageValue(message) {
  if (message === null || message === undefined) return '';
  if (message && Object.prototype.hasOwnProperty.call(message, 'value')) return String(message.value);
  return String(message);
}

function throwableMessage(jvm, throwable) {
  if (!throwable) return null;
  if (throwable.message) return throwable.message;
  return jvm.internString(String(throwable.type || 'java/lang/Throwable').replace(/\//g, '.'));
}

module.exports = {
  super: 'java/lang/RuntimeException',
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
    'getMessage()Ljava/lang/String;': (jvm, obj, args) => obj.message,
    'toString()Ljava/lang/String;': (jvm, obj, args) => {
      const message = obj.message;
      const className = obj.type.replace(/\//g, '.');
      return jvm.internString(message ? `${className}: ${messageValue(message)}` : className);
    },
  },
};

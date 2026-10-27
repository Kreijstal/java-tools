function javaString(value) {
  if (value === null || value === undefined) return null;
  if (value && value.type === 'java/lang/String' && Object.prototype.hasOwnProperty.call(value, 'value')) return value;
  if (value && Object.prototype.hasOwnProperty.call(value, 'value')) return value;
  return null;
}

function throwableMessage(jvm, throwable) {
  // Java: cause == null ? null : cause.toString().
  if (!throwable) return null;
  const className = String(throwable.type || 'java/lang/Throwable').replace(/\//g, '.');
  const message = throwable.message;
  if (message === null || message === undefined) return jvm.internString(className);
  const text = message && Object.prototype.hasOwnProperty.call(message, 'value') ? String(message.value) : String(message);
  return jvm.internString(`${className}: ${text}`);
}

function messageValue(message) {
  if (message === null || message === undefined) return '';
  if (message && Object.prototype.hasOwnProperty.call(message, 'value')) return String(message.value);
  return String(message);
}

// Throwable declares printStackTrace three ways in the JDK: no argument, one
// PrintWriter and one PrintStream. Modelling only two of them made the Java
// frontend match `printStackTrace(System.out)` against the PrintWriter overload
// and cast a PrintStream to it, which is a ClassCastException the moment the
// catch block runs.
// Java's printStackTrace text: the throwable and each cause. jvm.js records
// no frames. A PrintWriter or PrintStream argument is a JRE object, so the
// lines go through its println; the guest's StringWriter then holds them.
function stackTraceLines(obj) {
  const lines = [];
  const seen = new Set();
  for (let t = obj; t && !seen.has(t); t = t.cause) {
    const className = String(t.type).replace(/\//g, '.');
    const text = t.message === null || t.message === undefined ? className : `${className}: ${messageValue(t.message)}`;
    lines.push(seen.size === 0 ? text : `Caused by: ${text}`);
    lines.push('\tat <native method>');
    seen.add(t);
  }
  return lines;
}

function printThrowableTo(jvm, sink, obj) {
  const println = sink && typeof sink.println !== 'function' && typeof sink.type === 'string'
    ? jvm._jreFindMethod(sink.type, 'println', '(Ljava/lang/String;)V') : null;
  for (const line of stackTraceLines(obj)) {
    if (sink && typeof sink.println === 'function') sink.println(line);
    else if (println) println(jvm, sink, [jvm.internString(line)]);
    else console.error(line);
  }
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
    '<init>(Ljava/lang/String;Ljava/lang/Throwable;ZZ)V': (jvm, obj, args) => {
      obj.message = args[0];
      obj.cause = args[1];
      obj.suppressionEnabled = args[2] !== 0;
      obj.writableStackTrace = args[3] !== 0;
      obj.stackTrace = obj.writableStackTrace ? [] : null;
      obj.suppressedExceptions = obj.suppressionEnabled ? [] : null;
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
    'printStackTrace()V': (jvm, obj) => {
      printThrowableTo(jvm, null, obj);
    },
    'printStackTrace(Ljava/io/PrintWriter;)V': (jvm, obj, args) => {
      printThrowableTo(jvm, args[0], obj);
    },
    'printStackTrace(Ljava/io/PrintStream;)V': (jvm, obj, args) => {
      printThrowableTo(jvm, args[0], obj);
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
      // A fresh Java array each call, as in the JDK.
      const javaArray = (obj.suppressedExceptions || []).slice();
      javaArray.type = '[Ljava/lang/Throwable;';
      javaArray.elementType = 'java/lang/Throwable';
      javaArray.hashCode = jvm.nextHashCode++;
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

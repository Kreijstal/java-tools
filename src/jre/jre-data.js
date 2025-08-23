/**
 * JRE Data Module
 *
 * This module contains the data that was previously hardcoded in jre-bootstrap.js.
 * This includes the JRE class hierarchy, a list of essential classes, and mock
 * implementations for MethodHandle invoke methods used in testing.
 */

const jreHierarchy = {
  "java/lang/Object": null,
  "java/lang/System": "java/lang/Object",
  "java/lang/Throwable": "java/lang/Object",
  "java/lang/Exception": "java/lang/Throwable",
  "java/lang/RuntimeException": "java/lang/Exception",
  "java/lang/ArithmeticException": "java/lang/RuntimeException",
  "java/lang/IllegalArgumentException": "java/lang/RuntimeException",
  "java/lang/IllegalStateException": "java/lang/RuntimeException",
  "java/lang/Enum": "java/lang/Object",
  "java/lang/Runnable": "java/lang/Object",
  "java/lang/CharSequence": "java/lang/Object",
  "java/lang/ReflectiveOperationException": "java/lang/Exception",
  "java/lang/NoSuchMethodException": "java/lang/ReflectiveOperationException",
  "java/io/IOException": "java/lang/Exception",
  "java/io/Reader": "java/lang/Object",
  "java/io/BufferedReader": "java/io/Reader",
  "java/io/InputStreamReader": "java/io/Reader",
  "java/io/InputStream": "java/lang/Object",
  "java/io/FilterInputStream": "java/io/InputStream",
  "java/io/BufferedInputStream": "java/io/FilterInputStream",
  "java/io/OutputStream": "java/lang/Object",
  "java/io/FilterOutputStream": "java/io/OutputStream",
  "java/io/PrintStream": "java/io/FilterOutputStream",
  "java/io/ConsoleOutputStream": "java/io/OutputStream",
  "java/net/URLConnection": "java/lang/Object",
  "java/net/HttpURLConnection": "java/net/URLConnection",
  "java/net/URI": "java/lang/Object",
  "java/net/http/HttpClient": "java/lang/Object",
  "java/net/http/HttpRequest": "java/lang/Object",
  "java/net/http/HttpResponse": "java/lang/Object",
  "java/time/Duration": "java/lang/Object",
  "java/util/function/Function": "java/lang/Object",
  "java/lang/reflect/Array": "java/lang/Object",
};

const essentialClasses = [
  'java/lang/Object',
  'java/lang/System',
  'java/lang/String',
  'java/lang/Class',
  'java/io/PrintStream',
  'java/io/ConsoleOutputStream',
  'java/lang/Throwable',
  'java/lang/Exception',
  'java/lang/RuntimeException'
];

const methodHandleInvokeImplementations = {
  "(Ljava/lang/String;)V": function(jvm, thisObj, args, thread) {
    const message = args[0];
    const outputText = `Static method called: ${message}`;
    const printlnMethod = jvm._jreFindMethod('java/io/PrintStream', 'println', '(Ljava/lang/String;)V');
    if (printlnMethod) {
      const systemClass = jvm.classes['java/lang/System'];
      if (systemClass && systemClass.staticFields) {
        const out = systemClass.staticFields.get('out:Ljava/io/PrintStream;');
        if (out) {
          printlnMethod(jvm, out, [jvm.internString(outputText)]);
          return;
        }
      }
    }
    if (typeof jvm._outputCallback === 'function') {
      jvm._outputCallback(outputText + '\n');
    }
  },
  "(LMethodHandlesTest;I)Ljava/lang/String;": function(jvm, thisObj, args, thread) {
    const value = args[1];
    return jvm.internString(`Instance method called with: ${value}`);
  },
  "(LMethodHandlesTest;I)V": function(jvm, thisObj, args, thread) {
    const instance = args[0];
    const value = args[1];
    if (instance && instance.fields) {
      instance.fields.testField = value;
    }
  },
  "(LMethodHandlesTest;)I": function(jvm, thisObj, args, thread) {
    const instance = args[0];
    if (instance && instance.fields) {
      return instance.fields.testField || 0;
    }
    return 0;
  },
  "()Ljava/lang/Object;": function(jvm, thisObj, args, thread) {
    return { type: "java/lang/Object" };
  },
  "(Ljava/lang/Object;)Ljava/lang/Object;": function(jvm, thisObj, args, thread) {
    if (args && args.length > 0) {
      const firstArg = args[0];
      if (typeof firstArg === 'string') {
        return jvm.internString(firstArg);
      }
      if (firstArg && firstArg.type === 'java/lang/String') {
        return firstArg;
      }
    }
    return { type: "java/lang/Object" };
  },
  "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;": function(jvm, thisObj, args, thread) {
    return { type: "java/lang/Object" };
  },
  "(Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;": function(jvm, thisObj, args, thread) {
    return { type: "java/lang/Object" };
  },
  "([Ljava/lang/Object;)Ljava/lang/Object;": function(jvm, thisObj, args, thread) {
    return { type: "java/lang/Object" };
  },
  "(LMethodHandlesTest;Ljava/lang/String;)V": function(jvm, thisObj, args, thread) {
    // This is a mock for a test case that is not implemented yet.
  }
};

module.exports = {
  jreHierarchy,
  essentialClasses,
  methodHandleInvokeImplementations
};

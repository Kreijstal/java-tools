function asString(value) {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (value && value.type === 'java/lang/String' && Object.prototype.hasOwnProperty.call(value, 'value')) {
    return String(value.value);
  }
  return String(value);
}

function writeString(jvm, obj, value) {
  const output = asString(value);
  const writeMethod = jvm._jreFindMethod(obj.type, 'write', '(I)V');
  if (writeMethod) {
    for (let i = 0; i < output.length; i++) {
      writeMethod(jvm, obj, [output.charCodeAt(i)]);
    }
  }
}

function writeLineSeparator(jvm, obj) {
  const writeMethod = jvm._jreFindMethod(obj.type, 'write', '(I)V');
  if (writeMethod) {
    writeMethod(jvm, obj, ['\n'.charCodeAt(0)]);
  }
}

function flushIfAutoFlush(jvm, obj) {
  if (obj.autoFlush) {
    const flushMethod = jvm._jreFindMethod(obj.type, 'flush', '()V');
    if (flushMethod) {
      flushMethod(jvm, obj, []);
    }
  }
}

module.exports = {
  super: 'java/io/Writer',
  staticFields: {},
  methods: {
    '<init>(Ljava/io/Writer;)V': (jvm, obj, args) => {
      const writer = args[0];
      obj.out = writer;
      obj.autoFlush = false;
    },

    '<init>(Ljava/io/Writer;Z)V': (jvm, obj, args) => {
      const writer = args[0];
      const autoFlush = args[1];
      obj.out = writer;
      obj.autoFlush = !!autoFlush;
    },

    '<init>(Ljava/io/OutputStream;)V': (jvm, obj, args) => {
      const out = args[0];
      obj.out = out;
      obj.autoFlush = false;
    },

    '<init>(Ljava/io/OutputStream;Z)V': (jvm, obj, args) => {
      const out = args[0];
      const autoFlush = args[1];
      obj.out = out;
      obj.autoFlush = !!autoFlush;
    },

    'write(I)V': (jvm, obj, args) => {
      const c = args[0];
      const writeMethod = jvm._jreFindMethod(obj.out.type, 'write', '(I)V');
      if (writeMethod) {
        writeMethod(jvm, obj.out, [c]);
      }
    },

    'write([CII)V': (jvm, obj, args) => {
      const cbuf = args[0];
      const off = args[1];
      const len = args[2];

      const writeMethod = jvm._jreFindMethod(obj.out.type, 'write', '([CII)V');
      if (writeMethod) {
        writeMethod(jvm, obj.out, [cbuf, off, len]);
        return;
      }

      const writeIntMethod = jvm._jreFindMethod(obj.type, 'write', '(I)V');
      if (writeIntMethod) {
        for (let i = 0; i < len; i++) {
          writeIntMethod(jvm, obj, [cbuf[off + i]]);
        }
      }
    },

    'write(Ljava/lang/String;)V': (jvm, obj, args) => {
      writeString(jvm, obj, args[0]);
    },

    'write(Ljava/lang/String;II)V': (jvm, obj, args) => {
      const str = asString(args[0]);
      const off = args[1];
      const len = args[2];
      writeString(jvm, obj, str.substring(off, off + len));
    },

    'print(Ljava/lang/String;)V': (jvm, obj, args) => {
      writeString(jvm, obj, args[0]);
    },

    'print(Ljava/lang/Object;)V': (jvm, obj, args) => {
      writeString(jvm, obj, args[0]);
    },

    'println()V': (jvm, obj, args) => {
      writeLineSeparator(jvm, obj);
      flushIfAutoFlush(jvm, obj);
    },

    'println(Ljava/lang/String;)V': (jvm, obj, args) => {
      writeString(jvm, obj, args[0]);
      writeLineSeparator(jvm, obj);
      flushIfAutoFlush(jvm, obj);
    },

    'println(Ljava/lang/Object;)V': (jvm, obj, args) => {
      writeString(jvm, obj, args[0]);
      writeLineSeparator(jvm, obj);
      flushIfAutoFlush(jvm, obj);
    },

    'flush()V': (jvm, obj, args) => {
      const flushMethod = jvm._jreFindMethod(obj.out.type, 'flush', '()V');
      if (flushMethod) {
        flushMethod(jvm, obj.out, []);
      }
    },

    'close()V': (jvm, obj, args) => {
      const closeMethod = jvm._jreFindMethod(obj.out.type, 'close', '()V');
      if (closeMethod) {
        closeMethod(jvm, obj.out, []);
      }
    }
  }
};

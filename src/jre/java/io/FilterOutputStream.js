module.exports = {
  super: 'java/io/OutputStream',
  methods: {
    '<init>(Ljava/io/OutputStream;)V': (jvm, obj, args) => {
      const out = args[0];
      obj.out = out;
    },

    'write(I)V': (jvm, obj, args) => {
      const b = args[0];
      if (obj.out) {
        const writeByteMethod = jvm._jreFindMethod(obj.out.type, 'write', '(I)V');
        if (writeByteMethod) {
          writeByteMethod(jvm, obj.out, [b]);
        }
      }
    },

    'write([B)V': (jvm, obj, args) => {
      const b = args[0];
      if (obj.out) {
        const writeBytesMethod = jvm._jreFindMethod(obj.out.type, 'write', '([B)V');
        if (writeBytesMethod) {
          writeBytesMethod(jvm, obj.out, [b]);
        }
      }
    },

    'write([BII)V': (jvm, obj, args) => {
      const b = args[0];
      const off = args[1];
      const len = args[2];
      if (obj.out) {
        const writeBytesOffsetMethod = jvm._jreFindMethod(obj.out.type, 'write', '([BII)V');
        if (writeBytesOffsetMethod) {
          writeBytesOffsetMethod(jvm, obj.out, [b, off, len]);
        }
      }
    },

    'flush()V': (jvm, obj) => {
      if (obj.out) {
        const flushMethod = jvm._jreFindMethod(obj.out.type, 'flush', '()V');
        if (flushMethod) {
          flushMethod(jvm, obj.out, []);
        }
      }
    },

    'close()V': (jvm, obj) => {
      if (obj.out) {
        const closeMethod = jvm._jreFindMethod(obj.out.type, 'close', '()V');
        if (closeMethod) {
          closeMethod(jvm, obj.out, []);
        }
      }
    }
  }
};

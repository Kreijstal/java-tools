module.exports = {
  super: 'java/lang/Object',
  name: 'java/io/OutputStream',
  isAbstract: true,
  methods: {
    'close()V': (jvm, obj, args) => {},
    'flush()V': (jvm, obj, args) => {},
    'write([B)V': (jvm, obj, args) => {
      const b = args[0];
      if (b === null) {
        jvm.throwException('java/lang/NullPointerException');
        return;
      }
      const writeMethod = jvm._jreFindMethod(obj.type, 'write', '([BII)V');
      if (writeMethod) {
        writeMethod(jvm, obj, [b, 0, b.length]);
      }
    },
    'write([BII)V': (jvm, obj, args) => {
      const b = args[0];
      const off = args[1];
      const len = args[2];

      if (b === null) {
        jvm.throwException('java/lang/NullPointerException');
        return;
      }
      if (off < 0 || len < 0 || off + len > b.length) {
        jvm.throwException('java/lang/IndexOutOfBoundsException');
        return;
      }

      const writeByteMethod = jvm._jreFindMethod(obj.type, 'write', '(I)V');
      if (writeByteMethod) {
        for (let i = 0; i < len; i++) {
          writeByteMethod(jvm, obj, [b[off + i]]);
        }
      }
    },
    'write(I)V': {
      isAbstract: true
    }
  }
};

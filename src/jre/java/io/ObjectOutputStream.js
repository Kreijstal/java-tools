const { withThrows } = require('../../helpers');

// A signature-complete counterpart to ObjectInputStream: the serialization
// protocol is not implemented here either, but the class has to exist for
// `import java.io.*; new ObjectOutputStream(...)` to resolve to java/io rather
// than to the default package.
module.exports = {
  super: 'java/io/OutputStream',
  interfaces: ['java/io/ObjectOutput', 'java/io/ObjectStreamConstants'],
  staticFields: {},
  methods: {
    '<init>(Ljava/io/OutputStream;)V': (jvm, obj, args) => {
      obj.out = args[0];
    },

    'writeObject(Ljava/lang/Object;)V': withThrows((jvm) => {
      jvm.throwException('java/io/IOException', 'ObjectOutputStream.writeObject() not fully implemented');
    }, ['java/io/IOException']),

    'write(I)V': (jvm, obj, args) => {
      if (!obj.out) return;
      const write = jvm._jreFindMethod(obj.out.type, 'write', '(I)V');
      if (write) write(jvm, obj.out, [args[0]]);
    },

    'write([BII)V': (jvm, obj, args) => {
      if (!obj.out) return;
      const write = jvm._jreFindMethod(obj.out.type, 'write', '([BII)V');
      if (write) write(jvm, obj.out, [args[0], args[1], args[2]]);
    },

    'flush()V': (jvm, obj) => {
      if (!obj.out) return;
      const flush = jvm._jreFindMethod(obj.out.type, 'flush', '()V');
      if (flush) flush(jvm, obj.out, []);
    },

    'close()V': (jvm, obj) => {
      if (!obj.out) return;
      const close = jvm._jreFindMethod(obj.out.type, 'close', '()V');
      if (close) close(jvm, obj.out, []);
    },
  },
};

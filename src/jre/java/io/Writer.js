const { withThrows } = require('../../helpers');

// JRE Class: java/io/Writer
module.exports = {
  super: 'java/lang/Object',
  isAbstract: true,
  methods: {
    'write(I)V': function(jvm, obj, args, thread) {
      // Default implementation - abstract method
    },
    'write([C)V': withThrows(function(jvm, obj, args, thread) {
      const cbuf = args[0];
      if (cbuf === null) {
        jvm.throwException('java/lang/NullPointerException');
        return;
      }
      const writeMethod = jvm._jreFindMethod(obj.type, 'write', '([CII)V');
      if (writeMethod) {
        writeMethod(jvm, obj, [cbuf, 0, cbuf.length]);
      }
    }, ['java/lang/NullPointerException']),
    'write([CII)V': withThrows(function(jvm, obj, args, thread) {
      const cbuf = args[0];
      const off = args[1];
      const len = args[2];
      
      if (cbuf === null) {
        jvm.throwException('java/lang/NullPointerException');
        return;
      }
      if (off < 0 || len < 0 || off + len > cbuf.length) {
        jvm.throwException('java/lang/IndexOutOfBoundsException');
        return;
      }
      
      const writeCharMethod = jvm._jreFindMethod(obj.type, 'write', '(I)V');
      if (writeCharMethod) {
        for (let i = 0; i < len; i++) {
          writeCharMethod(jvm, obj, [cbuf[off + i]]);
        }
      }
    }, ['java/lang/NullPointerException', 'java/lang/IndexOutOfBoundsException']),
    'flush()V': function(jvm, obj, args, thread) {
      // Default implementation - do nothing
    },
    'close()V': function(jvm, obj, args, thread) {
      // Default implementation - do nothing
    }
  }
};

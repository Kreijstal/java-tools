const { withThrows } = require('../../helpers');

module.exports = {
  super: 'java/io/Reader',
  staticFields: {},
  methods: {
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
      const str = args[0];
      obj.str = str ? String(str) : "";
      obj.next = 0;
      obj.mark = 0;
    },
    
    'read()I': (jvm, obj, args) => {
      if (obj.next >= obj.str.length) {
        return -1;
      }
      return obj.str.charCodeAt(obj.next++);
    },
    
    'read([CII)I': withThrows((jvm, obj, args) => {
      const cbuf = args[0];
      const off = args[1];
      const len = args[2];
      
      if (cbuf === null) {
        jvm.throwException('java/lang/NullPointerException');
        return;
      }
      if (off < 0 || len < 0 || len > cbuf.length - off) {
        jvm.throwException('java/lang/IndexOutOfBoundsException');
        return;
      }
      
      if (len === 0) {
        return 0;
      }
      if (obj.next >= obj.str.length) {
        return -1;
      }
      
      const n = Math.min(obj.str.length - obj.next, len);
      for (let i = 0; i < n; i++) {
        cbuf[off + i] = obj.str.charCodeAt(obj.next + i);
      }
      obj.next += n;
      return n;
    }, ['java/lang/NullPointerException', 'java/lang/IndexOutOfBoundsException']),
    
    'close()V': (jvm, obj, args) => {
      obj.str = null;
    }
  }
};

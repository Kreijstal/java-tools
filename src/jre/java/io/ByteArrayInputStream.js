module.exports = {
  super: 'java/io/InputStream',
  staticFields: {},
  methods: {
    '<init>([B)V': (jvm, obj, args) => {
      const buf = args[0];
      obj.buf = buf;
      obj.pos = 0;
      obj.mark = 0;
      obj.count = buf ? buf.length : 0;
    },
    
    '<init>([BII)V': (jvm, obj, args) => {
      const buf = args[0];
      const offset = args[1];
      const length = args[2];
      
      obj.buf = buf;
      obj.pos = offset;
      obj.count = Math.min(offset + length, buf ? buf.length : 0);
      obj.mark = offset;
    },
    
    'read()I': (jvm, obj, args) => {
      if (obj.pos < obj.count) {
        return obj.buf[obj.pos++] & 0xff;
      }
      return -1;
    },
    
    'read([BII)I': (jvm, obj, args) => {
      const b = args[0];
      const off = args[1];
      const len = args[2];
      
      if (b === null) {
        jvm.throwException('java/lang/NullPointerException');
        return;
      }
      if (off < 0 || len < 0 || len > b.length - off) {
        jvm.throwException('java/lang/IndexOutOfBoundsException');
        return;
      }
      
      if (obj.pos >= obj.count) {
        return -1;
      }
      
      const avail = obj.count - obj.pos;
      const actualLen = len > avail ? avail : len;
      
      for (let i = 0; i < actualLen; i++) {
        b[off + i] = obj.buf[obj.pos + i];
      }
      obj.pos += actualLen;
      
      return actualLen;
    },
    
    'available()I': (jvm, obj, args) => {
      return obj.count - obj.pos;
    },

    'mark(I)V': (jvm, obj, args) => {
      obj.mark = obj.pos;
    },

    'reset()V': (jvm, obj, args) => {
      obj.pos = obj.mark;
    },

    'markSupported()Z': (jvm, obj, args) => {
      return 1; // true
    },
    
    'close()V': (jvm, obj, args) => {
      // No-op for ByteArrayInputStream
    }
  }
};
module.exports = {
  super: 'java/io/Writer',
  staticFields: {},
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.buffer = [];
    },
    
    '<init>(I)V': (jvm, obj, args) => {
      obj.buffer = [];
    },
    
    'write(I)V': (jvm, obj, args) => {
      const c = args[0];
      obj.buffer.push(c & 0xFFFF); // Mask to 16-bit for char
    },
    
    'write([CII)V': (jvm, obj, args) => {
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
      
      for (let i = 0; i < len; i++) {
        obj.buffer.push(cbuf[off + i]);
      }
    },
    
    'write(Ljava/lang/String;)V': (jvm, obj, args) => {
      const str = args[0];
      if (str && str.value) {
        for (let i = 0; i < str.value.length; i++) {
          obj.buffer.push(str.value.charCodeAt(i));
        }
      }
    },
    
    'toString()Ljava/lang/String;': (jvm, obj, args) => {
      const str = String.fromCharCode.apply(null, obj.buffer);
      return jvm.internString(str);
    },
    
    'flush()V': (jvm, obj, args) => {
      // No-op for StringWriter
    },
    
    'close()V': (jvm, obj, args) => {
      // No-op for StringWriter
    }
  }
};
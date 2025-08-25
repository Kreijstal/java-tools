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
      obj.autoFlush = autoFlush;
    },
    
    '<init>(Ljava/io/OutputStream;)V': (jvm, obj, args) => {
      const out = args[0];
      // Create OutputStreamWriter wrapper
      obj.out = {
        type: 'java/io/OutputStreamWriter',
        outputStream: out
      };
      obj.autoFlush = false;
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
      }
    },
    
    'print(Ljava/lang/String;)V': (jvm, obj, args) => {
      const str = args[0];
      if (str) {
        const s = String(str);
        for (let i = 0; i < s.length; i++) {
          const writeMethod = jvm._jreFindMethod(obj.type, 'write', '(I)V');
          if (writeMethod) {
            writeMethod(jvm, obj, [s.charCodeAt(i)]);
          }
        }
      }
    },
    
    'println(Ljava/lang/String;)V': (jvm, obj, args) => {
      const printMethod = jvm._jreFindMethod(obj.type, 'print', '(Ljava/lang/String;)V');
      if (printMethod) {
        printMethod(jvm, obj, args);
      }
      const writeMethod = jvm._jreFindMethod(obj.type, 'write', '(I)V');
      if (writeMethod) {
        writeMethod(jvm, obj, ['\n'.charCodeAt(0)]);
      }
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
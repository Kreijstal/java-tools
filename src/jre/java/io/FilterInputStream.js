module.exports = {
  super: 'java/io/InputStream',
  staticFields: {},
  methods: {
    '<init>(Ljava/io/InputStream;)V': (jvm, obj, args) => {
      const inputStream = args[0];
      obj.in = inputStream;
    },
    
    'read()I': (jvm, obj, args) => {
      if (obj.in) {
        const readMethod = jvm._jreFindMethod(obj.in.type, 'read', '()I');
        if (readMethod) {
          return readMethod(jvm, obj.in, []);
        }
      }
      return -1;
    },
    
    'read([B)I': (jvm, obj, args) => {
      const readMethod = jvm._jreFindMethod(obj.type, 'read', '([BII)I');
      if (readMethod) {
        const b = args[0];
        return readMethod(jvm, obj, [b, 0, b.length]);
      }
      return -1;
    },
    
    'read([BII)I': (jvm, obj, args) => {
      const b = args[0];
      const off = args[1];
      const len = args[2];
      
      if (obj.in) {
        const readMethod = jvm._jreFindMethod(obj.in.type, 'read', '([BII)I');
        if (readMethod) {
          return readMethod(jvm, obj.in, [b, off, len]);
        }
      }
      return -1;
    },
    
    'available()I': (jvm, obj, args) => {
      if (obj.in) {
        const availableMethod = jvm._jreFindMethod(obj.in.type, 'available', '()I');
        if (availableMethod) {
          return availableMethod(jvm, obj.in, []);
        }
      }
      return 0;
    },
    
    'close()V': (jvm, obj, args) => {
      if (obj.in) {
        const closeMethod = jvm._jreFindMethod(obj.in.type, 'close', '()V');
        if (closeMethod) {
          closeMethod(jvm, obj.in, []);
        }
      }
    }
  }
};
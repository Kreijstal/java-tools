const { withThrows } = require('../../helpers');

module.exports = {
  super: 'java/io/FilterInputStream',
  interfaces: ['java/io/DataInput'],
  staticFields: {},
  methods: {
    '<init>(Ljava/io/InputStream;)V': (jvm, obj, args) => {
      const inputStream = args[0];
      obj.in = inputStream;
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
    
    'read()I': (jvm, obj, args) => {
      if (obj.in) {
        const readMethod = jvm._jreFindMethod(obj.in.type, 'read', '()I');
        if (readMethod) {
          return readMethod(jvm, obj.in, []);
        }
      }
      return -1;
    },
    
    'readBoolean()Z': withThrows((jvm, obj, args) => {
      const readMethod = jvm._jreFindMethod(obj.type, 'read', '()I');
      if (readMethod) {
        const ch = readMethod(jvm, obj, []);
        if (ch < 0) {
          jvm.throwException('java/io/EOFException');
          return;
        }
        return ch !== 0;
      }
      return false;
    }, ['java/io/EOFException']),
    
    'readByte()B': withThrows((jvm, obj, args) => {
      const readMethod = jvm._jreFindMethod(obj.type, 'read', '()I');
      if (readMethod) {
        const ch = readMethod(jvm, obj, []);
        if (ch < 0) {
          jvm.throwException('java/io/EOFException');
          return;
        }
        return (ch << 24) >> 24; // Convert to signed byte
      }
      return 0;
    }, ['java/io/EOFException']),
    
    'readInt()I': withThrows((jvm, obj, args) => {
      const readMethod = jvm._jreFindMethod(obj.type, 'read', '()I');
      if (readMethod) {
        let ch1 = readMethod(jvm, obj, []);
        let ch2 = readMethod(jvm, obj, []);
        let ch3 = readMethod(jvm, obj, []);
        let ch4 = readMethod(jvm, obj, []);
        
        if ((ch1 | ch2 | ch3 | ch4) < 0) {
          jvm.throwException('java/io/EOFException');
          return;
        }
        
        return ((ch1 << 24) + (ch2 << 16) + (ch3 << 8) + (ch4 << 0));
      }
      return 0;
    }, ['java/io/EOFException']),
    
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

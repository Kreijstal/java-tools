const { withThrows } = require('../../helpers');

module.exports = {
  super: 'java/io/InputStream',
  interfaces: ['java/io/ObjectInput', 'java/io/ObjectStreamConstants'],
  staticFields: {},
  methods: {
    '<init>(Ljava/io/InputStream;)V': (jvm, obj, args) => {
      const inputStream = args[0];
      obj.in = inputStream;
      obj.objects = new Map();
      obj.handles = [];
      obj.nextHandle = 0x7E0000; // Base handle value
    },
    
    'readObject()Ljava/lang/Object;': withThrows((jvm, obj, args) => {
      // This is a simplified implementation
      // In a full implementation, this would need to handle the Java serialization protocol
      
      // For now, we'll throw an exception to indicate unsupported operation
      jvm.throwException('java/io/IOException', 'ObjectInputStream.readObject() not fully implemented');
      return null;
    }, ['java/io/IOException']),
    
    'read()I': (jvm, obj, args) => {
      if (obj.in) {
        const readMethod = jvm._jreFindMethod(obj.in.type, 'read', '()I');
        if (readMethod) {
          return readMethod(jvm, obj.in, []);
        }
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

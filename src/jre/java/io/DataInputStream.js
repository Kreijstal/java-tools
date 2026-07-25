const { withThrows } = require('../../helpers');

function readOne(jvm, obj) {
  const readMethod = jvm._jreFindMethod(obj.type, 'read', '()I');
  return readMethod ? readMethod(jvm, obj, []) : -1;
}

function readBytes(jvm, obj, count) {
  const bytes = [];
  for (let index = 0; index < count; index += 1) {
    const value = readOne(jvm, obj);
    if (value < 0) throw { type: 'java/io/EOFException' };
    bytes.push(value & 0xff);
  }
  return bytes;
}

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

    'readUnsignedByte()I': withThrows((jvm, obj) => readBytes(jvm, obj, 1)[0], ['java/io/EOFException']),
    'readShort()S': withThrows((jvm, obj) => {
      const bytes = readBytes(jvm, obj, 2);
      const value = (bytes[0] << 8) | bytes[1];
      return (value << 16) >> 16;
    }, ['java/io/EOFException']),
    'readUnsignedShort()I': withThrows((jvm, obj) => {
      const bytes = readBytes(jvm, obj, 2);
      return (bytes[0] << 8) | bytes[1];
    }, ['java/io/EOFException']),
    'readChar()C': withThrows((jvm, obj) => {
      const bytes = readBytes(jvm, obj, 2);
      return (bytes[0] << 8) | bytes[1];
    }, ['java/io/EOFException']),
    'readLong()J': withThrows((jvm, obj) => {
      const bytes = readBytes(jvm, obj, 8);
      let value = 0n;
      for (const byte of bytes) value = (value << 8n) | BigInt(byte);
      return BigInt.asIntN(64, value);
    }, ['java/io/EOFException']),
    'readFloat()F': withThrows((jvm, obj) => {
      const bytes = readBytes(jvm, obj, 4);
      const buffer = new ArrayBuffer(4);
      new Uint8Array(buffer).set(bytes);
      return new DataView(buffer).getFloat32(0, false);
    }, ['java/io/EOFException']),
    'readDouble()D': withThrows((jvm, obj) => {
      const bytes = readBytes(jvm, obj, 8);
      const buffer = new ArrayBuffer(8);
      new Uint8Array(buffer).set(bytes);
      return new DataView(buffer).getFloat64(0, false);
    }, ['java/io/EOFException']),
    'readFully([B)V': withThrows((jvm, obj, args) => {
      const bytes = readBytes(jvm, obj, args[0].length);
      for (let index = 0; index < bytes.length; index += 1) args[0][index] = bytes[index];
    }, ['java/io/EOFException']),
    'readFully([BII)V': withThrows((jvm, obj, args) => {
      const bytes = readBytes(jvm, obj, args[2]);
      for (let index = 0; index < bytes.length; index += 1) args[0][args[1] + index] = bytes[index];
    }, ['java/io/EOFException', 'java/lang/IndexOutOfBoundsException']),
    
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

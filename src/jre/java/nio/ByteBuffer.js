const { withThrows } = require('../../helpers');

module.exports = {
  super: "java/lang/Object",
  staticMethods: {
    'allocateDirect(I)Ljava/nio/ByteBuffer;': (jvm, obj, args) => {
      const capacity = args[0];
      const buffer = Buffer.alloc(capacity);
      const byteBuffer = {
        type: 'java/nio/ByteBuffer',
        'java/nio/ByteBuffer/buffer': buffer,
        'java/nio/Buffer/position': 0,
        'java/nio/Buffer/capacity': capacity,
        'java/nio/Buffer/limit': capacity,
        'java/nio/Buffer/mark': -1,
      };
      return byteBuffer;
    },
  },
  methods: {
    'capacity()I': (jvm, obj, args) => {
      return obj['java/nio/Buffer/capacity'];
    },
    'position()I': (jvm, obj, args) => {
      return obj['java/nio/Buffer/position'];
    },
    'position(I)Ljava/nio/ByteBuffer;': withThrows((jvm, obj, args) => {
      const newPosition = args[0];
      if (newPosition > obj['java/nio/Buffer/limit'] || newPosition < 0) {
        throw { type: 'java/lang/IllegalArgumentException', message: 'New position is out of bounds' };
      }
      obj['java/nio/Buffer/position'] = newPosition;
      return obj;
    }, ['java/lang/IllegalArgumentException']),
    'get([B)Ljava/nio/ByteBuffer;': withThrows((jvm, obj, args) => {
      const dest = args[0];
      const buffer = obj['java/nio/ByteBuffer/buffer'];
      let position = obj['java/nio/Buffer/position'];

      let destArray;
      if (dest && dest.array) {
        destArray = dest.array;
      } else if (Array.isArray(dest)) {
        destArray = dest;
      } else {
        throw { type: 'java/lang/IllegalArgumentException', message: 'Invalid byte array format for get' };
      }
      const length = destArray.length;

      if (obj['java/nio/Buffer/limit'] - position < length) {
        throw { type: 'java/nio/BufferUnderflowException' };
      }

      for (let i = 0; i < length; i++) {
        destArray[i] = buffer[position + i];
      }
      obj['java/nio/Buffer/position'] = position + length;
      return obj;
    }, ['java/lang/IllegalArgumentException', 'java/nio/BufferUnderflowException']),
    'put([B)Ljava/nio/ByteBuffer;': withThrows((jvm, obj, args) => {
      const src = args[0];
      const buffer = obj['java/nio/ByteBuffer/buffer'];
      let position = obj['java/nio/Buffer/position'];

      let srcArray;
      if (src && src.array) {
        srcArray = src.array;
      } else if (Array.isArray(src)) {
        srcArray = src;
      } else {
        throw { type: 'java/lang/IllegalArgumentException', message: 'Invalid byte array format for put' };
      }
      const length = srcArray.length;

      if (obj['java/nio/Buffer/limit'] - position < length) {
        throw { type: 'java/nio/BufferOverflowException' };
      }

      for (let i = 0; i < length; i++) {
        buffer[position + i] = srcArray[i];
      }
      obj['java/nio/Buffer/position'] = position + length;
      return obj;
    }, ['java/lang/IllegalArgumentException', 'java/nio/BufferOverflowException']),
  },
};

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
    'position(I)Ljava/nio/Buffer;': (jvm, obj, args) => {
      const newPosition = args[0];
      if (newPosition > obj['java/nio/Buffer/limit'] || newPosition < 0) {
        throw { type: 'java/lang/IllegalArgumentException', message: 'New position is out of bounds' };
      }
      obj['java/nio/Buffer/position'] = newPosition;
      return obj;
    },
    'get([B)Ljava/nio/ByteBuffer;': (jvm, obj, args) => {
      const dest = args[0];
      const buffer = obj['java/nio/ByteBuffer/buffer'];
      let position = obj['java/nio/Buffer/position'];
      const length = dest.array.length;

      if (obj['java/nio/Buffer/limit'] - position < length) {
        throw { type: 'java/nio/BufferUnderflowException' };
      }

      buffer.copy(dest.array, 0, position, position + length);
      obj['java/nio/Buffer/position'] = position + length;
      return obj;
    },
    'put([B)Ljava/nio/ByteBuffer;': (jvm, obj, args) => {
      const src = args[0];
      const buffer = obj['java/nio/ByteBuffer/buffer'];
      let position = obj['java/nio/Buffer/position'];
      const length = src.array.length;

      if (obj['java/nio/Buffer/limit'] - position < length) {
        throw { type: 'java/nio/BufferOverflowException' };
      }

      // Assuming src.array is a Buffer or similar object with a copy method
      src.array.copy(buffer, position, 0, length);
      obj['java/nio/Buffer/position'] = position + length;
      return obj;
    },
  },
};

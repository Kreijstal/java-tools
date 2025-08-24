const JNI = require('../../../jni');

module.exports = {
  super: "java/lang/Object",
  staticMethods: {
    'allocateDirect(I)Ljava/nio/ByteBuffer;': (jvm, obj, args) => {
      const capacity = args[0];
      const buffer = Buffer.alloc(capacity);
      const byteBuffer = new JNI.java.lang.Object();
      byteBuffer['java/nio/ByteBuffer/buffer'] = buffer;
      byteBuffer['java/nio/ByteBuffer/position'] = 0;
      return byteBuffer;
    },
  },
  methods: {
    'capacity()I': (jvm, obj, args) => {
      const buffer = obj['java/nio/ByteBuffer/buffer'];
      return buffer.length;
    },
    'position(I)Ljava/nio/Buffer;': (jvm, obj, args) => {
      const newPosition = args[0];
      obj['java/nio/ByteBuffer/position'] = newPosition;
      return obj;
    },
    'get([B)Ljava/nio/ByteBuffer;': (jvm, obj, args) => {
      const dest = args[0];
      const buffer = obj['java/nio/ByteBuffer/buffer'];
      const position = obj['java/nio/ByteBuffer/position'] || 0;
      const length = dest.array.length;
      buffer.copy(dest.array, 0, position, position + length);
      obj['java/nio/ByteBuffer/position'] = position + length;
      return obj;
    },
    'put([B)Ljava/nio/ByteBuffer;': (jvm, obj, args) => {
      const src = args[0];
      const buffer = obj['java/nio/ByteBuffer/buffer'];
      const position = obj['java/nio/ByteBuffer/position'] || 0;
      const length = src.array.length;
      src.array.copy(buffer, position, 0, length);
      obj['java/nio/ByteBuffer/position'] = position + length;
      return obj;
    },
  },
};

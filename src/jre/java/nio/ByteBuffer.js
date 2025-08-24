const JNI = require('../../../jni');

module.exports = {
  'java/nio/ByteBuffer': {
    'capacity()I': (thread, locals) => {
      const self = locals[0];
      const buffer = self['java/nio/ByteBuffer/buffer'];
      thread.pushStack(buffer.length);
    },
    'position(I)Ljava/nio/Buffer;': (thread, locals) => {
      const self = locals[0];
      const newPosition = locals[1];
      self['java/nio/ByteBuffer/position'] = newPosition;
      thread.pushStack(self);
    },
    'get([B)Ljava/nio/ByteBuffer;': (thread, locals) => {
      const self = locals[0];
      const dest = locals[1];
      const buffer = self['java/nio/ByteBuffer/buffer'];
      const position = self['java/nio/ByteBuffer/position'] || 0;
      const length = dest.array.length;
      buffer.copy(dest.array, 0, position, position + length);
      self['java/nio/ByteBuffer/position'] = position + length;
      thread.pushStack(self);
    },
    'allocateDirect(I)Ljava/nio/ByteBuffer;': (thread, locals) => {
      const capacity = locals[0];
      const buffer = Buffer.alloc(capacity);
      const byteBuffer = new JNI.java.lang.Object();
      byteBuffer['java/nio/ByteBuffer/buffer'] = buffer;
      byteBuffer['java/nio/ByteBuffer/position'] = 0;
      thread.pushStack(byteBuffer);
    },
    'put([B)Ljava/nio/ByteBuffer;': (thread, locals) => {
      const self = locals[0];
      const src = locals[1];
      const buffer = self['java/nio/ByteBuffer/buffer'];
      const position = self['java/nio/ByteBuffer/position'] || 0;
      const length = src.array.length;
      src.array.copy(buffer, position, 0, length);
      self['java/nio/ByteBuffer/position'] = position + length;
      thread.pushStack(self);
    },
  },
};

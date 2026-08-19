const { withThrows } = require('../../helpers');

function bufferOf(obj) {
  return obj['java/nio/ByteBuffer/buffer'];
}

function littleEndian(obj) {
  const order = obj['java/nio/ByteBuffer/order'];
  return !!(order && String(order.name || order.value || order).includes('LITTLE'));
}

function viewOf(obj) {
  const buffer = bufferOf(obj);
  return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function relativeOffset(obj, size) {
  const position = obj['java/nio/Buffer/position'];
  if (position + size > obj['java/nio/Buffer/limit']) {
    throw { type: 'java/nio/BufferUnderflowException' };
  }
  obj['java/nio/Buffer/position'] = position + size;
  return position;
}

function putOffset(obj, size) {
  const position = obj['java/nio/Buffer/position'];
  if (position + size > obj['java/nio/Buffer/limit']) {
    throw { type: 'java/nio/BufferOverflowException' };
  }
  obj['java/nio/Buffer/position'] = position + size;
  return position;
}

function guestBytes(array) {
  if (array && array.array) return array.array;
  return array;
}

function allocate(capacity, direct) {
  if (capacity < 0) {
    throw {
      type: 'java/lang/IllegalArgumentException',
      message: 'Negative capacity',
    };
  }
  const buffer = Buffer.alloc(capacity);
  return {
    type: 'java/nio/ByteBuffer',
    'java/nio/ByteBuffer/buffer': buffer,
    'java/nio/ByteBuffer/array': {
      type: '[B',
      array: new Int8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
    },
    'java/nio/ByteBuffer/direct': direct,
    'java/nio/ByteBuffer/order': { type: 'java/nio/ByteOrder', name: 'BIG_ENDIAN' },
    'java/nio/Buffer/position': 0,
    'java/nio/Buffer/capacity': capacity,
    'java/nio/Buffer/limit': capacity,
    'java/nio/Buffer/mark': -1,
  };
}

const setPosition = withThrows((jvm, obj, args) => {
  const newPosition = args[0];
  if (newPosition > obj['java/nio/Buffer/limit'] || newPosition < 0) {
    throw {
      type: 'java/lang/IllegalArgumentException',
      message: 'New position is out of bounds',
    };
  }
  obj['java/nio/Buffer/position'] = newPosition;
  if (obj['java/nio/Buffer/mark'] > newPosition) {
    obj['java/nio/Buffer/mark'] = -1;
  }
  return obj;
}, ['java/lang/IllegalArgumentException']);

const setLimit = withThrows((jvm, obj, args) => {
  const newLimit = Number(args[0]);
  if (newLimit < 0 || newLimit > obj['java/nio/Buffer/capacity']) {
    throw {
      type: 'java/lang/IllegalArgumentException',
      message: 'New limit is out of bounds',
    };
  }
  obj['java/nio/Buffer/limit'] = newLimit;
  if (obj['java/nio/Buffer/position'] > newLimit) {
    obj['java/nio/Buffer/position'] = newLimit;
  }
  if (obj['java/nio/Buffer/mark'] > newLimit) {
    obj['java/nio/Buffer/mark'] = -1;
  }
  return obj;
}, ['java/lang/IllegalArgumentException']);

module.exports = {
  super: "java/nio/Buffer",
  staticMethods: {
    'allocate(I)Ljava/nio/ByteBuffer;': withThrows((jvm, obj, args) =>
      allocate(args[0], false), ['java/lang/IllegalArgumentException']),
    'allocateDirect(I)Ljava/nio/ByteBuffer;': (jvm, obj, args) => {
      return allocate(args[0], true);
    },
    'wrap([B)Ljava/nio/ByteBuffer;': (jvm, obj, args) => {
      const bytes = guestBytes(args[0]);
      const result = allocate(bytes.length, false);
      const buffer = bufferOf(result);
      for (let i = 0; i < bytes.length; i++) buffer[i] = bytes[i] & 0xff;
      result['java/nio/ByteBuffer/array'] = args[0];
      return result;
    },
  },
  methods: {
    'capacity()I': (jvm, obj, args) => {
      return obj['java/nio/Buffer/capacity'];
    },
    'position()I': (jvm, obj, args) => {
      return obj['java/nio/Buffer/position'];
    },
    'order(Ljava/nio/ByteOrder;)Ljava/nio/ByteBuffer;': (jvm, obj, args) => {
      obj['java/nio/ByteBuffer/order'] = args[0];
      return obj;
    },
    'order()Ljava/nio/ByteOrder;': (jvm, obj) =>
      obj['java/nio/ByteBuffer/order'],
    'array()[B': (jvm, obj) => obj['java/nio/ByteBuffer/array'],
    'arrayOffset()I': () => 0,
    'hasArray()Z': (jvm, obj) => obj['java/nio/ByteBuffer/direct'] ? 0 : 1,
    'isDirect()Z': (jvm, obj) => obj['java/nio/ByteBuffer/direct'],
    'limit()I': (jvm, obj) => obj['java/nio/Buffer/limit'],
    'limit(I)Ljava/nio/ByteBuffer;': setLimit,
    'limit(I)Ljava/nio/Buffer;': setLimit,
    'remaining()I': (jvm, obj) =>
      obj['java/nio/Buffer/limit'] - obj['java/nio/Buffer/position'],
    'hasRemaining()Z': (jvm, obj) =>
      obj['java/nio/Buffer/position'] < obj['java/nio/Buffer/limit'] ? 1 : 0,
    'flip()Ljava/nio/Buffer;': (jvm, obj) => {
      obj['java/nio/Buffer/limit'] = obj['java/nio/Buffer/position'];
      obj['java/nio/Buffer/position'] = 0;
      obj['java/nio/Buffer/mark'] = -1;
      return obj;
    },
    'slice()Ljava/nio/ByteBuffer;': (jvm, obj) => {
      const start = obj['java/nio/Buffer/position'];
      const end = obj['java/nio/Buffer/limit'];
      const source = bufferOf(obj);
      const buffer = source.subarray(start, end);
      return {
        type: 'java/nio/ByteBuffer',
        'java/nio/ByteBuffer/buffer': buffer,
        'java/nio/ByteBuffer/array': {
          type: '[B',
          array: new Int8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
        },
        'java/nio/ByteBuffer/direct': obj['java/nio/ByteBuffer/direct'],
        'java/nio/ByteBuffer/order': obj['java/nio/ByteBuffer/order'],
        'java/nio/Buffer/position': 0,
        'java/nio/Buffer/capacity': buffer.length,
        'java/nio/Buffer/limit': buffer.length,
        'java/nio/Buffer/mark': -1,
      };
    },
    'get()B': (jvm, obj) =>
      viewOf(obj).getInt8(relativeOffset(obj, 1)),
    'get(I)B': (jvm, obj, args) => viewOf(obj).getInt8(args[0]),
    // Returns the buffer, not void - the frontend was inventing `([BII)V` for
    // this because the model did not declare it, and that reference resolves to
    // nothing at run time.
    'get([BII)Ljava/nio/ByteBuffer;': (jvm, obj, args) => {
      const [destination, offset, length] = args;
      const view = viewOf(obj);
      const start = relativeOffset(obj, length);
      for (let index = 0; index < length; index += 1) {
        destination[offset + index] = view.getInt8(start + index);
      }
      return obj;
    },
    'get([B)Ljava/nio/ByteBuffer;': (jvm, obj, args) => {
      const destination = args[0];
      const view = viewOf(obj);
      const start = relativeOffset(obj, destination.length);
      for (let index = 0; index < destination.length; index += 1) {
        destination[index] = view.getInt8(start + index);
      }
      return obj;
    },
    'put(B)Ljava/nio/ByteBuffer;': (jvm, obj, args) => {
      viewOf(obj).setInt8(putOffset(obj, 1), args[0]);
      return obj;
    },
    'put(IB)Ljava/nio/ByteBuffer;': (jvm, obj, args) => {
      viewOf(obj).setInt8(args[0], args[1]);
      return obj;
    },
    'getChar(I)C': (jvm, obj, args) =>
      viewOf(obj).getUint16(args[0], littleEndian(obj)),
    'putChar(C)Ljava/nio/ByteBuffer;': (jvm, obj, args) => {
      viewOf(obj).setUint16(putOffset(obj, 2), args[0], littleEndian(obj));
      return obj;
    },
    'putChar(IC)Ljava/nio/ByteBuffer;': (jvm, obj, args) => {
      viewOf(obj).setUint16(args[0], args[1], littleEndian(obj));
      return obj;
    },
    'getShort()S': (jvm, obj) =>
      viewOf(obj).getInt16(relativeOffset(obj, 2), littleEndian(obj)),
    'getShort(I)S': (jvm, obj, args) =>
      viewOf(obj).getInt16(args[0], littleEndian(obj)),
    'putShort(S)Ljava/nio/ByteBuffer;': (jvm, obj, args) => {
      viewOf(obj).setInt16(putOffset(obj, 2), args[0], littleEndian(obj));
      return obj;
    },
    'putShort(IS)Ljava/nio/ByteBuffer;': (jvm, obj, args) => {
      viewOf(obj).setInt16(args[0], args[1], littleEndian(obj));
      return obj;
    },
    'getInt()I': (jvm, obj) =>
      viewOf(obj).getInt32(relativeOffset(obj, 4), littleEndian(obj)),
    'getInt(I)I': (jvm, obj, args) =>
      viewOf(obj).getInt32(args[0], littleEndian(obj)),
    'putInt(I)Ljava/nio/ByteBuffer;': (jvm, obj, args) => {
      viewOf(obj).setInt32(putOffset(obj, 4), args[0], littleEndian(obj));
      return obj;
    },
    'putInt(II)Ljava/nio/ByteBuffer;': (jvm, obj, args) => {
      viewOf(obj).setInt32(args[0], args[1], littleEndian(obj));
      return obj;
    },
    'getLong(I)J': (jvm, obj, args) =>
      viewOf(obj).getBigInt64(args[0], littleEndian(obj)),
    'putLong(J)Ljava/nio/ByteBuffer;': (jvm, obj, args) => {
      viewOf(obj).setBigInt64(putOffset(obj, 8), args[0], littleEndian(obj));
      return obj;
    },
    'putLong(IJ)Ljava/nio/ByteBuffer;': (jvm, obj, args) => {
      viewOf(obj).setBigInt64(args[0], args[1], littleEndian(obj));
      return obj;
    },
    'putFloat(F)Ljava/nio/ByteBuffer;': (jvm, obj, args) => {
      viewOf(obj).setFloat32(putOffset(obj, 4), args[0], littleEndian(obj));
      return obj;
    },
    'putDouble(D)Ljava/nio/ByteBuffer;': (jvm, obj, args) => {
      viewOf(obj).setFloat64(putOffset(obj, 8), args[0], littleEndian(obj));
      return obj;
    },
    'put([BII)Ljava/nio/ByteBuffer;': (jvm, obj, args) => {
      const source = guestBytes(args[0]);
      const offset = args[1];
      const length = args[2];
      const targetOffset = putOffset(obj, length);
      const target = bufferOf(obj);
      for (let i = 0; i < length; i++) target[targetOffset + i] = source[offset + i] & 0xff;
      return obj;
    },
    'put(Ljava/nio/ByteBuffer;)Ljava/nio/ByteBuffer;': (jvm, obj, args) => {
      const source = args[0];
      const length = source['java/nio/Buffer/limit'] - source['java/nio/Buffer/position'];
      const sourceOffset = source['java/nio/Buffer/position'];
      const targetOffset = putOffset(obj, length);
      bufferOf(source).copy(bufferOf(obj), targetOffset, sourceOffset, sourceOffset + length);
      source['java/nio/Buffer/position'] += length;
      return obj;
    },
    // javac may target either the covariant ByteBuffer method or its Buffer
    // bridge, depending on the expression's static type.
    'position(I)Ljava/nio/ByteBuffer;': setPosition,
    'position(I)Ljava/nio/Buffer;': setPosition,
    'get([B)Ljava/nio/ByteBuffer;': withThrows((jvm, obj, args) => {
      const dest = args[0];
      const buffer = obj['java/nio/ByteBuffer/buffer'];
      let position = obj['java/nio/Buffer/position'];

      let destArray;
      if (dest && dest.array) {
        destArray = dest.array;
      } else if (Array.isArray(dest) || ArrayBuffer.isView(dest)) {
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
      } else if (Array.isArray(src) || ArrayBuffer.isView(src)) {
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

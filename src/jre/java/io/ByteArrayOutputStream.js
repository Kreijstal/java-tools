function ensureCapacity(obj, minCapacity) {
  if (!obj.buf) {
    obj.buf = [];
  }
  if (obj.buf.length < minCapacity) {
    obj.buf.length = minCapacity;
  }
}

function toByte(value) {
  return value & 0xff;
}

module.exports = {
  super: 'java/io/OutputStream',
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.buf = [];
      obj.count = 0;
    },

    '<init>(I)V': (jvm, obj, args) => {
      obj.buf = new Array(args[0]);
      obj.count = 0;
    },

    'write(I)V': (jvm, obj, args) => {
      ensureCapacity(obj, obj.count + 1);
      obj.buf[obj.count++] = toByte(args[0]);
    },

    'write([BII)V': (jvm, obj, args) => {
      const source = args[0];
      const off = args[1];
      const len = args[2];

      if (source === null) {
        jvm.throwException('java/lang/NullPointerException');
      }
      if (off < 0 || len < 0 || off + len > source.length) {
        jvm.throwException('java/lang/IndexOutOfBoundsException');
      }

      ensureCapacity(obj, obj.count + len);
      for (let i = 0; i < len; i++) {
        obj.buf[obj.count + i] = toByte(source[off + i]);
      }
      obj.count += len;
    },

    'toByteArray()[B': (jvm, obj, args) => {
      const bytes = obj.buf.slice(0, obj.count).map(toByte);
      bytes.type = '[B';
      bytes.elementType = 'byte';
      bytes.hashCode = jvm.nextHashCode++;
      return bytes;
    },

    'size()I': (jvm, obj, args) => {
      return obj.count;
    },

    'reset()V': (jvm, obj, args) => {
      obj.count = 0;
    },

    'close()V': (jvm, obj, args) => {},
  }
};

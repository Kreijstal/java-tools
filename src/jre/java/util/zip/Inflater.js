const zlib = require('zlib');

module.exports = {
  super: "java/lang/Object",
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj['java/util/zip/Inflater/inflater'] = zlib.createInflate();
      obj['java/util/zip/Inflater/buffer'] = null;
    },
    '<init>(Z)V': (jvm, obj, args) => {
      const nowrap = args[0];
      if (nowrap) {
        obj['java/util/zip/Inflater/inflater'] = zlib.createInflateRaw();
      } else {
        obj['java/util/zip/Inflater/inflater'] = zlib.createInflate();
      }
      obj['java/util/zip/Inflater/buffer'] = null;
    },
    'setInput([BII)V': (jvm, obj, args) => {
      const b = args[0];
      const off = args[1];
      const len = args[2];

      let byteArray;
      if (b && b.array) {
        byteArray = b.array;
      } else if (Array.isArray(b)) {
        byteArray = b;
      } else {
        throw new Error('Invalid byte array format');
      }

      obj['java/util/zip/Inflater/buffer'] = Buffer.from(byteArray.slice(off, off + len));
    },
    'inflate([B)I': (jvm, obj, args) => {
      const b = args[0].array;
      const inflater = obj['java/util/zip/Inflater/inflater'];
      const buffer = obj['java/util/zip/Inflater/buffer'];
      if (buffer) {
        inflater.write(buffer);
      }
      const result = inflater.read();
      if (result) {
        result.copy(b);
        return result.length;
      } else {
        return 0;
      }
    },
    'reset()V': (jvm, obj, args) => {
      const inflater = obj['java/util/zip/Inflater/inflater'];
      if (inflater.reset) { // Not all zlib streams have reset
        inflater.reset();
      }
      obj['java/util/zip/Inflater/buffer'] = null;
    },
  },
};

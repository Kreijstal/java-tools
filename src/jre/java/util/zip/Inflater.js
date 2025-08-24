const zlib = require('zlib');

module.exports = {
  super: "java/lang/Object",
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj['java/util/zip/Inflater/nowrap'] = false;
      obj['java/util/zip/Inflater/buffer'] = null;
    },
    '<init>(Z)V': (jvm, obj, args) => {
      const nowrap = args[0];
      obj['java/util/zip/Inflater/nowrap'] = nowrap;
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
      const dest = args[0];
      let destArray;
      if (dest && dest.array) {
        destArray = dest.array;
      } else if (Array.isArray(dest)) {
        destArray = dest;
      } else {
        throw new Error('Invalid byte array format for inflate');
      }

      const buffer = obj['java/util/zip/Inflater/buffer'];
      if (!buffer) {
        return 0;
      }

      const nowrap = obj['java/util/zip/Inflater/nowrap'];

      let decompressed;
      try {
        if (nowrap) {
            decompressed = zlib.inflateRawSync(buffer);
        } else {
            decompressed = zlib.inflateSync(buffer);
        }
      } catch (e) {
        throw { type: 'java/util/zip/DataFormatException', message: e.message };
      }

      if (decompressed) {
        const length = Math.min(decompressed.length, destArray.length);
        for (let i = 0; i < length; i++) {
          destArray[i] = decompressed[i];
        }
        return length;
      } else {
        return 0;
      }
    },
    'reset()V': (jvm, obj, args) => {
      obj['java/util/zip/Inflater/buffer'] = null;
    },
    'end()V': (jvm, obj, args) => {
      // No-op
    },
  },
};

const zlib = require('zlib');

module.exports = {
  super: "java/lang/Object",
  methods: {
    '<init>(Z)V': (jvm, obj, args) => {
      const nowrap = args[0];
      obj['java/util/zip/Inflater/inflater'] = zlib.createInflateRaw({
        windowBits: nowrap ? 0 : 15,
      });
      obj['java/util/zip/Inflater/buffer'] = null;
    },
    'setInput([BII)V': (jvm, obj, args) => {
      const b = args[0].array;
      const off = args[1];
      const len = args[2];
      obj['java/util/zip/Inflater/buffer'] = b.slice(off, off + len);
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
      obj['java/util/zip/Inflater/inflater'].reset();
      obj['java/util/zip/Inflater/buffer'] = null;
    },
  },
};

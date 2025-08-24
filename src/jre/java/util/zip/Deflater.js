const zlib = require('zlib');

module.exports = {
  super: 'java/lang/Object',
  interfaces: [],
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.input = null;
      obj.level = -1; // Default compression
      obj.finished = false;
    },
    '<init>(I)V': (jvm, obj, args) => {
        obj.input = null;
        obj.level = args[0];
        obj.finished = false;
    },
    '<init>(IZ)V': (jvm, obj, args) => {
        obj.input = null;
        obj.level = args[0];
        obj.nowrap = args[1];
        obj.finished = false;
    },
    'setInput([B)V': (jvm, obj, args) => {
      obj.input = Buffer.from(args[0]);
    },
    'finish()V': (jvm, obj, args) => {
      // no-op, handled by deflate
    },
    'finished()Z': (jvm, obj, args) => {
      return obj.finished ? 1 : 0;
    },
    'deflate([B)I': (jvm, obj, args) => {
      if (!obj.input) {
        obj.finished = true;
        return 0;
      }
      const options = { level: obj.level };
      const output = obj.nowrap
        ? zlib.deflateRawSync(obj.input, options)
        : zlib.deflateSync(obj.input, options);

      const target = args[0];
      for (let i = 0; i < output.length; i++) {
        target[i] = output[i];
      }
      obj.finished = true;
      return output.length;
    },
    'end()V': (jvm, obj, args) => {
      // no-op
    },
  },
};

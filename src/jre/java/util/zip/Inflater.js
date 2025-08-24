const zlib = require('zlib');

module.exports = {
  super: 'java/lang/Object',
  interfaces: [],
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.input = null;
      obj.finished = false;
      obj.nowrap = false;
    },
    '<init>(Z)V': (jvm, obj, args) => {
      obj.input = null;
      obj.finished = false;
      obj.nowrap = args[0];
    },
    'setInput([BII)V': (jvm, obj, args) => {
      const b = args[0];
      const off = args[1];
      const len = args[2];
      obj.input = Buffer.from(b.slice(off, off + len));
    },
    'inflate([B)I': (jvm, obj, args) => {
      if (!obj.input) {
        obj.finished = true;
        return 0;
      }
      const output = obj.nowrap
        ? zlib.inflateRawSync(obj.input)
        : zlib.inflateSync(obj.input);

      const target = args[0];
      for (let i = 0; i < output.length; i++) {
        target[i] = output[i];
      }
      obj.finished = true;
      return output.length;
    },
    'finished()Z': (jvm, obj, args) => {
      return obj.finished ? 1 : 0;
    },
    'needsInput()Z': (jvm, obj, args) => {
      return (obj.input === null) ? 1 : 0;
    },
    'end()V': (jvm, obj, args) => {
      // no-op
    },
    'reset()V': (jvm, obj, args) => {
      obj.input = null;
      obj.finished = false;
    },
  },
};

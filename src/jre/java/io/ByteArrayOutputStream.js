module.exports = {
  super: 'java/io/OutputStream',
  interfaces: [],
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.buffer = [];
    },

    '<init>(I)V': (jvm, obj, args) => {
      // initial size is not used in this implementation
      obj.buffer = [];
    },

    'write([BII)V': (jvm, obj, args) => {
      const b = args[0];
      const off = args[1];
      const len = args[2];
      for (let i = 0; i < len; i++) {
        obj.buffer.push(b[off + i]);
      }
    },

    'toByteArray()[B': (jvm, obj, args) => {
      const byteArray = new Int8Array(obj.buffer);
      byteArray.type = '[B';
      return byteArray;
    },

    'close()V': (jvm, obj, args) => {
      // no-op
    },
  },
};

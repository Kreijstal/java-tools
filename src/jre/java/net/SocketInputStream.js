const { Buffers, readByte, readInto, waitForData } = require('./socketRegistry');

module.exports = {
  super: 'java/io/InputStream',
  methods: {
    'available()I': (jvm, obj) => {
      const state = Buffers.get(obj.socketId);
      return state ? state.size : 0;
    },
    'read()I': async (jvm, obj) => {
      const state = Buffers.get(obj.socketId);
      if (!state) return -1;
      // Block (cooperatively) until data or close, like Java's read().
      while (state.size === 0 && !state.closed) {
        await waitForData(state);
      }
      return readByte(state);
    },
    'read([B)I': async (jvm, obj, args) => {
      const state = Buffers.get(obj.socketId);
      const arr = args[0] || [];
      if (!state) return -1;
      while (state.size === 0 && !state.closed) {
        await waitForData(state);
      }
      return readInto(state, arr, 0, arr.length);
    },
    'read([BII)I': async (jvm, obj, args) => {
      const state = Buffers.get(obj.socketId);
      const arr = args[0] || [];
      if (!state) return -1;
      while (state.size === 0 && !state.closed) {
        await waitForData(state);
      }
      return readInto(state, arr, args[1] | 0, args[2] | 0);
    },
    'close()V': () => {},
  },
};

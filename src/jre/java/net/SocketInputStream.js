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
      if (process.env.JVM_DEBUG_SOCKET) {
        state.consumed = (state.consumed || 0) + 1;
        if (state.consumed % 2048 === 0) console.error(`[socket ${obj.socketId} consumed] ${state.consumed}B total, ${state.size}B pending`);
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
      let len = args[2] | 0;
      // JVM_SOCKET_READ_CAP bounds how many bytes a single read() returns,
      // mimicking real-JVM behavior of returning one TCP segment at a time.
      // Node coalesces segments into large buffers, and some clients
      // (dekobloko's JS5 de-chunker) mis-assemble when a single read spans
      // many 512-byte protocol blocks.
      const cap = Number(process.env.JVM_SOCKET_READ_CAP);
      if (Number.isFinite(cap) && cap > 0 && len > cap) len = cap;
      return readInto(state, arr, args[1] | 0, len);
    },
    'close()V': () => {},
  },
};

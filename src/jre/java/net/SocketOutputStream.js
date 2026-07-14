const { Sockets } = require('./socketRegistry');

function writeBytes(obj, bytes) {
  const nativeSocket = Sockets.get(obj.socketId);
  if (nativeSocket && !nativeSocket.destroyed) {
    nativeSocket.write(Buffer.from(bytes));
  }
}

module.exports = {
  super: 'java/io/OutputStream',
  methods: {
    'write(I)V': (jvm, obj, args) => {
      writeBytes(obj, [args[0] & 0xff]);
    },
    'write([B)V': (jvm, obj, args) => {
      const arr = args[0] || [];
      writeBytes(obj, arr.map((b) => b & 0xff));
    },
    'write([BII)V': (jvm, obj, args) => {
      const arr = args[0] || [];
      const off = args[1] | 0;
      const len = args[2] | 0;
      const out = new Array(len);
      for (let i = 0; i < len; i++) out[i] = arr[off + i] & 0xff;
      writeBytes(obj, out);
    },
    'flush()V': () => {},
    'close()V': () => {},
  },
};

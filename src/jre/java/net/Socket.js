const net = require('net');

// Using a map to store native sockets, as we can't store complex JS objects in Java fields.
const Sockets = new Map();
let nextSocketId = 0;

module.exports = {
  super: 'java/lang/Object',
  methods: {
    // Constructor
    '<init>(Ljava/net/InetAddress;I)V': (jvm, obj, args) => {
      const address = args[0]; // This is an InetAddress object from our JRE
      const port = args[1];

      const host = address.hostName.value; // Get JS string from the Java String object

      const nativeSocket = new net.Socket();
      const socketId = nextSocketId++;
      Sockets.set(socketId, nativeSocket);

      obj.socketId = socketId;
      obj.isClosed = false;

      // Node's connect is async. We fire and forget for now.
      nativeSocket.connect(port, host, () => {
        // Connected.
      });

      // Prevent unhandled errors from crashing the process.
      nativeSocket.on('error', (err) => {
        // In a full implementation, this error should be stored and
        // thrown as a Java exception on the next socket operation.
        // For now, we just log it and prevent a crash.
        console.error(`Socket error for ${host}:${port}:`, err.message);
      });
    },

    'connect(Ljava/net/SocketAddress;)V': (jvm, obj, args) => {
      const endpoint = args[0]; // This is an InetSocketAddress object
      const host = endpoint.hostname.value;
      const port = endpoint.port;

      const nativeSocket = Sockets.get(obj.socketId);
      if (nativeSocket) {
        nativeSocket.connect(port, host, () => {
          // Connected.
        });
      }
    },

    'setSoTimeout(I)V': (jvm, obj, args) => {
      const timeout = args[0];
      const nativeSocket = Sockets.get(obj.socketId);
      if (nativeSocket) {
        nativeSocket.setTimeout(timeout);
      }
    },

    'setTcpNoDelay(Z)V': (jvm, obj, args) => {
      const on = args[0]; // 1 for true, 0 for false
      const nativeSocket = Sockets.get(obj.socketId);
      if (nativeSocket) {
        nativeSocket.setNoDelay(on === 1);
      }
    },

    'close()V': (jvm, obj, args) => {
      if (obj.isClosed) {
          return;
      }
      const nativeSocket = Sockets.get(obj.socketId);
      if (nativeSocket) {
          nativeSocket.destroy();
          Sockets.delete(obj.socketId);
      }
      obj.isClosed = true;
    },

    'getOutputStream()Ljava/io/OutputStream;': (jvm, obj, args) => {
      const outputStream = {
        type: 'java/io/OutputStream',
        socketId: obj.socketId,
      };
      return outputStream;
    },

    'getInputStream()Ljava/io/InputStream;': (jvm, obj, args) => {
      const inputStream = {
        type: 'java/io/InputStream',
        socketId: obj.socketId,
      };
      return inputStream;
    }
  }
};

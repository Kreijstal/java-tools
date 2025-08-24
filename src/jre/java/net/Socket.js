const net = require('net');

// Using a map to store native sockets, as we can't store complex JS objects in Java fields.
const Sockets = new Map();
let nextSocketId = 0;

module.exports = {
  '<init>(Ljava/net/InetAddress;I)V': (jvm, frame, locals) => {
    const thisSocket = locals[0];
    const address = locals[1];
    const port = locals[2];

    const host = jvm.interned_string_to_string(address.get_field('java/net/InetAddress', 'hostName', 'Ljava/lang/String;'));

    const nativeSocket = new net.Socket();
    const socketId = nextSocketId++;
    Sockets.set(socketId, nativeSocket);

    thisSocket.set_field('java/net/Socket', 'socketId', 'I', socketId);

    // Node's connect is async. We can't block, so we fire and forget.
    // Any errors would need to be handled via events, which the JRE doesn't seem to support well.
    nativeSocket.connect(port, host, () => {
      // Connected.
    });

    thisSocket.set_field('java/net/Socket', 'isClosed', 'Z', false);
  },

  'connect(Ljava/net/SocketAddress;)V': (jvm, frame, locals) => {
    const thisSocket = locals[0];
    const endpoint = locals[1]; // This is an InetSocketAddress

    const host = jvm.interned_string_to_string(endpoint.get_field('java/net/InetSocketAddress', 'hostname', 'Ljava/lang/String;'));
    const port = endpoint.get_field('java/net/InetSocketAddress', 'port', 'I');

    const socketId = thisSocket.get_field('java/net/Socket', 'socketId', 'I');
    const nativeSocket = Sockets.get(socketId);

    nativeSocket.connect(port, host, () => {
      // Connected.
    });
  },

  'setSoTimeout(I)V': (jvm, frame, locals) => {
    const thisSocket = locals[0];
    const timeout = locals[1];
    const socketId = thisSocket.get_field('java/net/Socket', 'socketId', 'I');
    const nativeSocket = Sockets.get(socketId);
    nativeSocket.setTimeout(timeout);
  },

  'setTcpNoDelay(Z)V': (jvm, frame, locals) => {
    const thisSocket = locals[0];
    const on = locals[1];
    const socketId = thisSocket.get_field('java/net/Socket', 'socketId', 'I');
    const nativeSocket = Sockets.get(socketId);
    nativeSocket.setNoDelay(on);
  },

  'close()V': (jvm, frame, locals) => {
    const thisSocket = locals[0];
    if (thisSocket.get_field('java/net/Socket', 'isClosed', 'Z')) {
        return;
    }
    const socketId = thisSocket.get_field('java/net/Socket', 'socketId', 'I');
    const nativeSocket = Sockets.get(socketId);
    if (nativeSocket) {
        nativeSocket.destroy();
        Sockets.delete(socketId);
    }
    thisSocket.set_field('java/net/Socket', 'isClosed', 'Z', true);
  },

  'getOutputStream()Ljava/io/OutputStream;': (jvm, frame, locals) => {
    const thisSocket = locals[0];
    const outputStream = jvm.new_class('java/io/OutputStream');
    const socketId = thisSocket.get_field('java/net/Socket', 'socketId', 'I');
    // We need to associate the stream with the socket.
    // We assume the OutputStream class has a field for this.
    outputStream.set_field('java/io/OutputStream', 'socketId', 'I', socketId);
    jvm.push_stack(outputStream);
  },

  'getInputStream()Ljava/io/InputStream;': (jvm, frame, locals) => {
    const thisSocket = locals[0];
    const inputStream = jvm.new_class('java/io/InputStream');
    const socketId = thisSocket.get_field('java/net/Socket', 'socketId', 'I');
    // We need to associate the stream with the socket.
    // We assume the InputStream class has a field for this.
    inputStream.set_field('java/io/InputStream', 'socketId', 'I', socketId);
    jvm.push_stack(inputStream);
  }
};

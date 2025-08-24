module.exports = {
  '<init>(Ljava/lang/String;I)V': (jvm, frame, locals) => {
    const thisSocketAddress = locals[0];
    const hostname = locals[1];
    const port = locals[2];

    thisSocketAddress.set_field('java/net/InetSocketAddress', 'hostname', 'Ljava/lang/String;', hostname);
    thisSocketAddress.set_field('java/net/InetSocketAddress', 'port', 'I', port);
  },

  'getHostName()Ljava/lang/String;': (jvm, frame, locals) => {
    const thisSocketAddress = locals[0];
    const hostname = thisSocketAddress.get_field('java/net/InetSocketAddress', 'hostname', 'Ljava/lang/String;');
    jvm.push_stack(hostname);
  },

  'getPort()I': (jvm, frame, locals) => {
    const thisSocketAddress = locals[0];
    const port = thisSocketAddress.get_field('java/net/InetSocketAddress', 'port', 'I');
    jvm.push_stack(port);
  },
};

module.exports = {
  // Constructor is not in the request, but needed for the class to be useful.
  '<init>(Ljava/net/Proxy$Type;Ljava/net/SocketAddress;)V': (jvm, frame, locals) => {
    const thisProxy = locals[0];
    const type = locals[1];
    const address = locals[2];

    thisProxy.set_field('java/net/Proxy', 'type', 'Ljava/net/Proxy$Type;', type);
    thisProxy.set_field('java/net/Proxy', 'address', 'Ljava/net/SocketAddress;', address);
  },

  'type()Ljava/net/Proxy$Type;': (jvm, frame, locals) => {
    const thisProxy = locals[0];
    const type = thisProxy.get_field('java/net/Proxy', 'type', 'Ljava/net/Proxy$Type;');
    jvm.push_stack(type);
  },

  'address()Ljava/net/SocketAddress;': (jvm, frame, locals) => {
    const thisProxy = locals[0];
    const address = thisProxy.get_field('java/net/Proxy', 'address', 'Ljava/net/SocketAddress;');
    jvm.push_stack(address);
  },
};

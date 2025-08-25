module.exports = {
  super: 'java/lang/Object',
  methods: {
    // Constructor is not in the original request, but needed for the class to be useful.
    '<init>(Ljava/net/Proxy$Type;Ljava/net/SocketAddress;)V': (jvm, obj, args) => {
      obj.type = args[0]; // The Proxy.Type enum object
      obj.address = args[1]; // The SocketAddress object
    },

    'type()Ljava/net/Proxy$Type;': (jvm, obj, args) => {
      return obj.type;
    },

    'address()Ljava/net/SocketAddress;': (jvm, obj, args) => {
      return obj.address;
    },
  }
};

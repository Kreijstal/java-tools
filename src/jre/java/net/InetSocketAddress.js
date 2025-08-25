module.exports = {
  super: 'java/lang/Object',
  methods: {
    '<init>(Ljava/lang/String;I)V': (jvm, obj, args) => {
      const hostname = args[0];
      const port = args[1];
      obj.hostname = hostname;
      obj.port = port;
    },
    'getHostName()Ljava/lang/String;': (jvm, obj, args) => {
      return obj.hostname;
    },
    'getPort()I': (jvm, obj, args) => {
      return obj.port;
    },
  }
};

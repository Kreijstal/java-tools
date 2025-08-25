const dns = require('dns');

module.exports = {
  super: 'java/lang/Object',
  staticMethods: {
    'getByName(Ljava/lang/String;)Ljava/net/InetAddress;': (jvm, obj, args) => {
      const hostname = args[0];
      const jsHostname = hostname.value;

      const inetAddress = {
        type: 'java/net/InetAddress',
        hostName: hostname,
        address: null,
      };

      // Using a hardcoded IP address because dns.lookupSync causes
      // unrecoverable errors in this execution environment.
      const dummyIp = [93, 184, 216, 34]; // Real IP for example.com
      const byteArray = Array.from(dummyIp);
      byteArray.type = '[B';
      byteArray.elementType = 'byte';
      inetAddress.address = byteArray;

      return inetAddress;
    },
  },
  methods: {
    'getHostName()Ljava/lang/String;': (jvm, obj, args) => {
      return obj.hostName;
    },

    'getAddress()[B': (jvm, obj, args) => {
      return obj.address;
    },
  }
};

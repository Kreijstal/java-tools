
const { promises: dnsPromises } = require('dns');


module.exports = {
  super: 'java/lang/Object',
  staticMethods: {

    'getByName(Ljava/lang/String;)Ljava/net/InetAddress;': async (jvm, obj, args) => {

      const hostname = args[0];
      const jsHostname = hostname.value;

      const inetAddress = {
        type: 'java/net/InetAddress',
        hostName: hostname,
        address: null,
      };

      try {
        const lookupResult = await dnsPromises.lookup(jsHostname, { family: 4 });
        const ipBytes = lookupResult.address.split('.').map(s => parseInt(s, 10));
        const byteArray = Array.from(ipBytes);
        byteArray.type = '[B';
        byteArray.elementType = 'byte';
        inetAddress.address = byteArray;
      } catch (e) {
        throw {
          type: 'java/net/UnknownHostException',
          message: jsHostname,
        };
      }


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

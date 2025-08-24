const dns = require('dns');

module.exports = {
  // Static method
  'getByName(Ljava/lang/String;)Ljava/net/InetAddress;': (jvm, frame, locals) => {
    const hostname = locals[0];
    const inetAddress = jvm.new_class('java/net/InetAddress');
    inetAddress.set_field('java/net/InetAddress', 'hostName', 'Ljava/lang/String;', hostname);
    // Address is lazily initialized in getAddress()
    jvm.push_stack(inetAddress);
  },

  'getHostName()Ljava/lang/String;': (jvm, frame, locals) => {
    const thisAddress = locals[0];
    const hostName = thisAddress.get_field('java/net/InetAddress', 'hostName', 'Ljava/lang/String;');
    jvm.push_stack(hostName);
  },

  'getAddress()[B': (jvm, frame, locals) => {
    const thisAddress = locals[0];
    let address = thisAddress.get_field('java/net/InetAddress', 'address', '[B');

    if (address) {
      jvm.push_stack(address);
      return;
    }

    // Since we cannot easily do a synchronous DNS lookup, we return a dummy address.
    // This is a common workaround in environments where async operations are not supported
    // in a sync-style API.
    const dummyIp = [127, 0, 0, 1];
    address = jvm.new_array('[B', dummyIp.length);
    for (let i = 0; i < dummyIp.length; i++) {
      address.elements[i] = dummyIp[i];
    }

    thisAddress.set_field('java/net/InetAddress', 'address', '[B', address);
    jvm.push_stack(address);
  },
};

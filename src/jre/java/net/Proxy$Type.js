module.exports = {
  super: 'java/lang/Enum',
  staticFields: {
    'DIRECT:Ljava/net/Proxy$Type;': null,
    'HTTP:Ljava/net/Proxy$Type;': null,
    'SOCKS:Ljava/net/Proxy$Type;': null,
  },
  methods: {
    '<clinit>()V': (jvm, _, args) => {
      const proxyTypeClass = jvm.classes['java/net/Proxy$Type'];
      const direct = { type: 'java/net/Proxy$Type', name: 'DIRECT', ordinal: 0 };
      const http = { type: 'java/net/Proxy$Type', name: 'HTTP', ordinal: 1 };
      const socks = { type: 'java/net/Proxy$Type', name: 'SOCKS', ordinal: 2 };
      proxyTypeClass.staticFields.set('DIRECT:Ljava/net/Proxy$Type;', direct);
      proxyTypeClass.staticFields.set('HTTP:Ljava/net/Proxy$Type;', http);
      proxyTypeClass.staticFields.set('SOCKS:Ljava/net/Proxy$Type;', socks);
    },
  },
};

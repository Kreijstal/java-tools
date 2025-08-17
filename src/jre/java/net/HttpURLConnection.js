module.exports = {
  super: 'java/net/URLConnection',
  staticFields: {},
  methods: {
    'getResponseCode()I': async (jvm, obj, args) => {
      const connect = jvm._jreGetNative('java/net/URLConnection', '_connect');
      await connect(obj);
      return obj.responseCode;
    },
    'disconnect()V': (jvm, obj, args) => {
      // no-op
    },
  },
};

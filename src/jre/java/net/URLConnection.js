const fetch = require('../../../fetch-polyfill');

module.exports = {
  super: 'java/lang/Object',
  staticFields: {},
  methods: {
    'getInputStream()Ljava/io/InputStream;': async (jvm, obj, args) => {
      const connect = jvm._jreGetNative('java/net/URLConnection', '_connect');
      await connect(obj);
      const text = obj.body;
      let index = 0;

      const inputStream = { type: 'java/io/InputStream' };
      inputStream['java/io/InputStream'] = {
        read: () => {
          if (index < text.length) {
            return text.charCodeAt(index++);
          } else {
            return -1;
          }
        },
      };

      return inputStream;
    },
  },
  _connect: async (obj) => {
    if (obj.connected) {
      return;
    }

    const response = await fetch(obj.url);
    const text = await response.text();

    obj.responseCode = response.status;
    obj.body = text;
    obj.connected = true;
  }
};

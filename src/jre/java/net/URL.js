module.exports = {
  super: 'java/lang/Object',
  staticFields: {},
  methods: {
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj.url = args[0];
      return obj;
    },
    'openConnection()Ljava/net/URLConnection;': (jvm, obj, args) => {
      const urlConnection = { type: 'java/net/HttpURLConnection', url: obj.url };
      return urlConnection;
    },
    'getProtocol()Ljava/lang/String;': (jvm, obj, args) => {
      const urlString = obj.url.value; // Assuming .value holds the JS string
      const protocol = new URL(urlString).protocol.replace(':', '');
      return jvm.internString(protocol);
    },

    '<init>(Ljava/net/URL;Ljava/lang/String;)V': (jvm, obj, args) => {
      const context = args[0];
      const spec = args[1];
      const contextString = context.url.value;
      const specString = spec.value;

      const newUrl = new URL(specString, contextString);
      obj.url = jvm.internString(newUrl.href);
      return obj;
    },

    'toString()Ljava/lang/String;': (jvm, obj, args) => {
      return obj.url;
    },

    'getHost()Ljava/lang/String;': (jvm, obj, args) => {
      const urlString = obj.url.value;
      const host = new URL(urlString).hostname;
      return jvm.internString(host);
    },

    'getFile()Ljava/lang/String;': (jvm, obj, args) => {
      const urlString = obj.url.value;
      const url = new URL(urlString);
      const file = url.pathname + url.search;
      return jvm.internString(file);
    },

    'openStream()Ljava/io/InputStream;': (jvm, obj, args) => {
      // This is a shorthand for openConnection().getInputStream().
      // The existing openConnection is a stub, so this will also be a stub.
      // Returning a placeholder InputStream object.
      const inputStream = {
        type: 'java/io/InputStream',
      };
      return inputStream;
    },
  }
};

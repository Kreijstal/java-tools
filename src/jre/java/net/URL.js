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
      const protocol = obj.url.split(':')[0];
      return jvm.internString(protocol);
    }
  }
};

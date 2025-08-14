module.exports = {
  'java/net/URL.<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
    obj.url = args[0];
    return obj;
  },
  'java/net/URL.openConnection()Ljava/net/URLConnection;': (jvm, obj, args) => {
    const urlConnection = { type: 'java/net/HttpURLConnection', url: obj.url };
    return urlConnection;
  },
  'java/net/URL.getProtocol()Ljava/lang/String;': (jvm, obj, args) => {
    const protocol = obj.url.split(':')[0];
    return jvm.internString(protocol);
  }
};

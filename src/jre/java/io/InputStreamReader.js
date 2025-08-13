module.exports = {
  'java/io/InputStreamReader.<init>': (jvm, obj, args) => {
    obj.inputStream = args[0];
    return obj;
  },
  'java/io/InputStreamReader.read': (jvm, obj, args) => {
    const stream = obj.inputStream['java/io/InputStream'];
    if (stream && stream.read) {
      return stream.read();
    }
    return -1;
  }
};

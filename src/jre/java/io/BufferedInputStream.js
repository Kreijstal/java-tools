module.exports = {
  'java/io/BufferedInputStream.<init>': (obj, args) => {
    obj.inputStream = args[0];
    return obj;
  },
  'java/io/BufferedInputStream.read': (obj, args) => {
    const stream = obj.inputStream['java/io/InputStream'];
    if (stream && stream.read) {
      return stream.read();
    }
    return -1;
  }
};

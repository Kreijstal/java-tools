module.exports = {
  super: 'java/io/Reader',
  staticFields: {},
  methods: {
    '<init>(Ljava/io/InputStream;)V': (jvm, obj, args) => {
      obj.inputStream = args[0];
      return obj;
    },
    'read()I': (jvm, obj, args) => {
      const stream = obj.inputStream['java/io/InputStream'];
      if (stream && stream.read) {
        return stream.read();
      }
      return -1;
    }
  }
};

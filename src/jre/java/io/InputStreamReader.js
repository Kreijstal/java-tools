module.exports = {
  super: "java/io/Reader",
  staticFields: {},
  methods: {
    "<init>(Ljava/io/InputStream;)V": (jvm, obj, args) => {
      obj.inputStream = args[0];
      return obj;
    },
    "read()I": (jvm, obj, args) => {
      const stream = obj.inputStream["java/io/InputStream"];
      if (stream && stream.read) {
        return stream.read();
      }
      // Also check if the inputStream object itself has a read method
      if (obj.inputStream && obj.inputStream.read) {
        return obj.inputStream.read();
      }
      return -1;
    },
  },
};

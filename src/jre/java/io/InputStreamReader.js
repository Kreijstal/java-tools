module.exports = {
  super: "java/io/Reader",
  methods: {
    '<init>(Ljava/io/InputStream;)V': (jvm, obj, args) => {
      const inputStream = args[0];
      obj['java/io/InputStreamReader/stream'] = inputStream;
      // Default charset would be used here in a full implementation
    },
    '<init>(Ljava/io/InputStream;Ljava/lang/String;)V': (jvm, obj, args) => {
      const inputStream = args[0];
      const charsetName = args[1];
      obj['java/io/InputStreamReader/stream'] = inputStream;
      obj['java/io/InputStreamReader/charsetName'] = charsetName;
    },
    '<init>(Ljava/io/InputStream;Ljava/nio/charset/Charset;)V': (jvm, obj, args) => {
      const inputStream = args[0];
      const charset = args[1];
      obj['java/io/InputStreamReader/stream'] = inputStream;
      obj['java/io/InputStreamReader/charset'] = charset;
    },
    'read()I': (jvm, obj, args) => {
      const stream = obj['java/io/InputStreamReader/stream'];
      
      if (!stream) {
        return -1;
      }
      
      // Call the InputStream's read method
      if (stream.read && typeof stream.read === 'function') {
        // For TestInputStream objects created in test-helpers
        return stream.read();
      }
      
      // Try to find the read method via JRE method lookup
      const readMethod = jvm._jreFindMethod(stream.type || 'java/io/InputStream', 'read', '()I');
      if (readMethod) {
        return readMethod(jvm, stream, []);
      }
      
      return -1;
    },
  },
};

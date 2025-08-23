// JRE Class: java/io/InputStreamReader
module.exports = {
  super: 'java/io/Reader',
  methods: {
    '<init>(Ljava/io/InputStream;)V': function(jvm, obj, args) {
      const inputStream = args[0];
      obj.stream = inputStream;
      return obj;
    },
    'read()I': function(jvm, obj, args) {
      const stream = obj.stream;
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
    'close()V': function(jvm, obj, args) {
      // Default implementation - do nothing
    }
  }
};

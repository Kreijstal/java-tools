module.exports = {
  'java/io/InputStreamReader': {
    '<init>(Ljava/io/InputStream;)V': (thread, locals) => {
      const self = locals[0];
      const inputStream = locals[1];
      self['java/io/InputStreamReader/stream'] = inputStream;
      thread.return();
    },
    'read()I': (thread, locals) => {
      const self = locals[0];
      const stream = self['java/io/InputStreamReader/stream'];
      
      if (!stream) {
        thread.return(-1);
        return;
      }
      
      // Call the InputStream's read method
      if (stream.read && typeof stream.read === 'function') {
        // For TestInputStream objects created in test-helpers
        const result = stream.read();
        thread.return(result);
        return;
      }
      
      // Try to find the read method via JRE method lookup
      const jvm = thread.jvm;
      const readMethod = jvm._jreFindMethod(stream.type || 'java/io/InputStream', 'read', '()I');
      if (readMethod) {
        const result = readMethod(jvm, stream, []);
        thread.return(result);
        return;
      }
      
      thread.return(-1);
    },
  },
};

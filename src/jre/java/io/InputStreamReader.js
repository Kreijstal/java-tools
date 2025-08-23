module.exports = {
  'java/io/InputStreamReader': {
    '<init>(Ljava/io/InputStream;)V': (thread, locals) => {
      const self = locals[0];
      const inputStream = locals[1];
      self['java/io/InputStreamReader/stream'] = inputStream;
      thread.return();
    },
  },
};

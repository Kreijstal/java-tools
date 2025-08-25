// JRE Class: java/io/InputStream
module.exports = {
  super: 'java/lang/Object',
  methods: {
    'read()I': function(jvm, obj, args, thread) {
      // Default implementation - return -1 (end of stream)
      return -1;
    },
    'read([BII)I': function(jvm, obj, args, thread) {
      // Default implementation - return -1 (end of stream)
      return -1;
    },
    'close()V': function(jvm, obj, args, thread) {
      // Default implementation - do nothing
    },
    'available()I': function(jvm, obj, args, thread) {
      // Default implementation - return 0 (no bytes available)
      return 0;
    },
    'readAllBytes()[B': async function(jvm, obj, args, thread) {
      const stream = obj.stream;
      if (!stream) {
        // This is a default InputStream, not one from a URL.
        // Return an empty byte array.
        return jvm.newByteArray([]);
      }

      return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const byteArray = jvm.newByteArray(buffer);
          resolve(byteArray);
        });
        stream.on('error', reject);
      });
    }
  }
};

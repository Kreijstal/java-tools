// JRE Class: java/io/InputStream
const { withThrows } = require('../../helpers');

module.exports = {
  super: 'java/lang/Object',
  methods: {
    'read()I': withThrows(function(jvm, obj, args, thread) {
      // Default implementation - return -1 (end of stream)
      return -1;
    }, ['java/io/IOException']),
    'read([BII)I': withThrows(function(jvm, obj, args, thread) {
      // Default implementation - return -1 (end of stream)
      return -1;
    }, ['java/io/IOException']),
    'close()V': withThrows(function(jvm, obj, args, thread) {
      // Default implementation - do nothing
    }, ['java/io/IOException']),
    'available()I': withThrows(function(jvm, obj, args, thread) {
      // Default implementation - return 0 (no bytes available)
      return 0;
    }, ['java/io/IOException']),
    'readAllBytes()[B': withThrows(async function(jvm, obj, args, thread) {
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
    }, ['java/io/IOException'])
  }
};

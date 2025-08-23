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
    }
  }
};

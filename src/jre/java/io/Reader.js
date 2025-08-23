// JRE Class: java/io/Reader
module.exports = {
  super: 'java/lang/Object',
  methods: {
    'read()I': function(jvm, obj, args, thread) {
      // Default implementation - return -1 (end of stream)
      return -1;
    },
    'read([C)V': function(jvm, obj, args, thread) {
      // Default implementation - do nothing
    },
    'close()V': function(jvm, obj, args, thread) {
      // Default implementation - do nothing
    }
  }
};
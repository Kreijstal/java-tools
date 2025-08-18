module.exports = {
  super: 'java/lang/Object',
  methods: {
    '<init>()V': (jvm, obj, args) => {
      // no-op
    },
    'read()I': (jvm, obj, args) => {
      // Always return -1 (end of stream)
      return -1;
    },
  },
};

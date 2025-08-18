module.exports = {
  super: 'java/io/OutputStream',
  methods: {
    '<init>(Ljava/lang/Object;)V': (jvm, obj, args) => {
      // The argument is a native JS function passed from the JRE internals.
      obj.writer = args[0];
    },
    'write(I)V': (jvm, obj, args) => {
      const byte = args[0];
      const char = String.fromCharCode(byte);
      if (jvm.testOutputCallback) {
        jvm.testOutputCallback(char);
        return;
      }
      if (obj.writer) {
        obj.writer(char);
      }
    },
  },
};
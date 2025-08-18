module.exports = {
  super: 'java/io/OutputStream',
  methods: {
    'write(I)V': (jvm, obj, args) => {
      const byte = args[0];
      const char = String.fromCharCode(byte);
      if (jvm.testOutputCallback) {
        jvm.testOutputCallback(char);
      } else if (typeof process !== 'undefined' && process.stdout) {
        process.stdout.write(char);
      }
    },
  },
};
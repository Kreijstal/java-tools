module.exports = {
  super: 'java/io/FilterOutputStream',
  staticFields: {},
  methods: {
    'println(Ljava/lang/String;)V': (jvm, obj, args) => {
      const output = args[0] + '\n';
      if (jvm.testOutputCallback) {
        jvm.testOutputCallback(output);
      } else {
        process.stdout.write(output);
      }
    },
    'println(I)V': (jvm, obj, args) => {
      const output = args[0] + '\n';
      if (jvm.testOutputCallback) {
        jvm.testOutputCallback(output);
      } else {
        process.stdout.write(output);
      }
    },
    'println([C)V': (jvm, obj, args) => {
      const output = String.fromCharCode.apply(null, args[0]) + '\n';
      if (jvm.testOutputCallback) {
        jvm.testOutputCallback(output);
      } else {
        process.stdout.write(output);
      }
    },
    'println(Ljava/lang/Object;)V': (jvm, obj, args) => {
      // This is a simplification. In a real JVM, it would call the object's toString() method.
      const val = args[0];
      if (val === null) {
        if (jvm.testOutputCallback) {
          jvm.testOutputCallback('\n');
        } else {
          process.stdout.write('\n');
        }
        return;
      }
      const output = val + '\n';
      if (jvm.testOutputCallback) {
        jvm.testOutputCallback(output);
      } else {
        process.stdout.write(output);
      }
    },
    'println()V': (jvm, obj, args) => {
      if (jvm.testOutputCallback) {
        jvm.testOutputCallback('\n');
      } else {
        process.stdout.write('\n');
      }
    },
    'println(Z)V': (jvm, obj, args) => {
      const output = (args[0] === 1 ? 'true' : 'false') + '\n';
      if (jvm.testOutputCallback) {
        jvm.testOutputCallback(output);
      } else {
        process.stdout.write(output);
      }
    },
  },
};

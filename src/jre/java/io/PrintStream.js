module.exports = {
  super: 'java/io/FilterOutputStream',
  staticFields: {},
  methods: {
    'println(Ljava/lang/String;)V': (jvm, obj, args) => {
      const output = args[0];
      if (jvm.testOutputCallback) {
        jvm.testOutputCallback(output);
      } else {
        console.log(output);
      }
    },
    'println(I)V': (jvm, obj, args) => {
      const output = args[0];
      if (jvm.testOutputCallback) {
        jvm.testOutputCallback(output);
      } else {
        console.log(output);
      }
    },
    'println([C)V': (jvm, obj, args) => {
      const output = String.fromCharCode.apply(null, args[0]);
      if (jvm.testOutputCallback) {
        jvm.testOutputCallback(output);
      } else {
        console.log(output);
      }
    },
    'println(Ljava/lang/Object;)V': (jvm, obj, args) => {
      // This is a simplification. In a real JVM, it would call the object's toString() method.
      const output = args[0];
      if (jvm.testOutputCallback) {
        jvm.testOutputCallback(output);
      } else {
        console.log(output);
      }
    },
    'println()V': (jvm, obj, args) => {
      if (jvm.testOutputCallback) {
        jvm.testOutputCallback('');
      } else {
        console.log();
      }
    },
    'println(Z)V': (jvm, obj, args) => {
      const output = args[0] === 1 ? 'true' : 'false';
      if (jvm.testOutputCallback) {
        jvm.testOutputCallback(output);
      } else {
        console.log(output);
      }
    },
  },
};

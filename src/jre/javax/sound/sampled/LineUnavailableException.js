module.exports = {
  super: 'java/lang/Exception',
  methods: {
    '<init>()V': (jvm, obj, args) => {
      const exception = obj;
      const exceptionClass = jvm.findClass('java/lang/Exception');
      jvm.runMethod(exceptionClass, '<init>()V', [exception]);
    },
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
      const [msg] = args;
      const exception = obj;
      const exceptionClass = jvm.findClass('java/lang/Exception');
      jvm.runMethod(exceptionClass, '<init>(Ljava/lang/String;)V', [exception, msg]);
    },
  },
};

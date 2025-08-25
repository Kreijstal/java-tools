module.exports = {
  super: 'java/lang/Exception',
  methods: {
    '<init>()V': (jvm, obj, args) => {
      const exception = obj;
      const exceptionClassDef = jvm.jre['java/lang/Exception'];
      exceptionClassDef.methods['<init>()V'](jvm, obj, [exception]);
    },
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
      const [msg] = args;
      const exception = obj;
      const exceptionClassDef = jvm.jre['java/lang/Exception'];
      exceptionClassDef.methods['<init>(Ljava/lang/String;)V'](jvm, obj, [exception, msg]);
    },
  },
};

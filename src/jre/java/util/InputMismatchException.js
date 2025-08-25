module.exports = {
  super: 'java/lang/RuntimeException',
  methods: {
    '<init>()V': (jvm, obj, args) => {
      // Call parent constructor
      const parentInit = jvm._jreFindMethod('java/lang/RuntimeException', '<init>', '()V');
      if (parentInit) {
        parentInit(jvm, obj, []);
      }
    },
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
      // Call parent constructor with message
      const parentInit = jvm._jreFindMethod('java/lang/RuntimeException', '<init>', '(Ljava/lang/String;)V');
      if (parentInit) {
        parentInit(jvm, obj, args);
      }
    }
  }
};
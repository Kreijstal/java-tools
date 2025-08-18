module.exports = {
  super: 'java/lang/RuntimeException',
  staticFields: {},
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.message = jvm.internString('/ by zero');
    },
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj.message = args[0] || jvm.internString('/ by zero');
    },
    'getMessage()Ljava/lang/String;': (jvm, obj, args) => {
      return obj.message || jvm.internString('/ by zero');
    },
    'toString()Ljava/lang/String;': (jvm, obj, args) => {
      const message = obj.message || jvm.internString('/ by zero');
      return jvm.internString(`java.lang.ArithmeticException: ${message.value}`);
    },
  },
};
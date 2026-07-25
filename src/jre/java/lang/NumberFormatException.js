module.exports = {
  super: 'java/lang/IllegalArgumentException',
  staticFields: {},
  methods: {
    '<init>()V': (jvm, obj) => {
      obj.message = null;
    },
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj.message = args[0];
    },
    'getMessage()Ljava/lang/String;': (jvm, obj) => obj.message,
    'toString()Ljava/lang/String;': (jvm, obj) => {
      const message = obj.message;
      const className = obj.type.replace(/\//g, '.');
      return jvm.internString(message ? `${className}: ${message.value}` : className);
    },
  },
};

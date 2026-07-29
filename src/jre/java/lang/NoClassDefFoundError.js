module.exports = {
  super: 'java/lang/LinkageError',
  methods: {
    '<init>()V': (jvm, obj) => {
      obj.message = null;
    },
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj.message = args[0];
    },
  },
};

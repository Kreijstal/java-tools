module.exports = {
  super: 'java/lang/ReflectiveOperationException',
  staticFields: {},
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.message = null;
    },
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj.message = args[0];
    },
  },
};

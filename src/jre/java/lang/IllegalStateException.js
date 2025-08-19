module.exports = {
  super: 'java/lang/RuntimeException',
  staticFields: {},
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.hashCode = jvm.nextHashCode++;
      obj.message = null;
      delete obj.isUninitialized;
    },
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj.hashCode = jvm.nextHashCode++;
      obj.message = args[0];
      delete obj.isUninitialized;
    },
  },
};
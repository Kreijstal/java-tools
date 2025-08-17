module.exports = {
  super: 'java/lang/ReflectiveOperationException',
  staticFields: {},
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.hashCode = jvm.nextHashCode++;
      delete obj.isUninitialized;
    },
  },
};

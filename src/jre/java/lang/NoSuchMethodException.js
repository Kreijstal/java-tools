module.exports = {
  'java/lang/NoSuchMethodException.<init>()V': (jvm, obj, args) => {
    obj.hashCode = jvm.nextHashCode++;
    delete obj.isUninitialized;
  },
};

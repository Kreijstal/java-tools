module.exports = {
  'java/lang/IllegalArgumentException.<init>()V': (jvm, obj, args) => {
    obj.hashCode = jvm.nextHashCode++;
    delete obj.isUninitialized;
  },
};

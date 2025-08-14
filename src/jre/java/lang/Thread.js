module.exports = {
  'java/lang/Thread.<init>()V': (jvm, obj, args) => {
    obj.hashCode = jvm.nextHashCode++;
    delete obj.isUninitialized;
  },
  'java/lang/Thread.start()V': (jvm, obj, args) => {
    // The logic for starting a new thread is handled in invokevirtual
    // instruction. This is just a placeholder.
  },
};

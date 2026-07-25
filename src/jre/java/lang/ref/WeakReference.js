module.exports = {
  super: 'java/lang/ref/Reference',
  methods: {
    '<init>(Ljava/lang/Object;)V': (jvm, obj, args) => { obj._referent = args[0] || null; },
    '<init>(Ljava/lang/Object;Ljava/lang/ref/ReferenceQueue;)V': (jvm, obj, args) => {
      obj._referent = args[0] || null;
      obj._queue = args[1] || null;
    },
  },
};

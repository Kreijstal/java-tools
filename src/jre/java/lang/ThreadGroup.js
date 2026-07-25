module.exports = {
  super: 'java/lang/Object',
  methods: {
    'getParent()Ljava/lang/ThreadGroup;': (jvm, obj) => obj.parent || null,
    'enumerate([Ljava/lang/Thread;)I': (jvm, obj, args) => {
      const threads = obj.threads || [];
      const target = args[0] || [];
      const count = Math.min(threads.length, target.length);
      for (let index = 0; index < count; index += 1) target[index] = threads[index];
      return count;
    },
  },
};

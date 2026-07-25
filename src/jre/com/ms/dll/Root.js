module.exports = {
  super: 'java/lang/Object',
  methods: {
    '<init>()V': () => {},
  },
  staticMethods: {
    'alloc(Ljava/lang/Object;)I': (jvm, obj, args) => {
      const value = args[0];
      if (!jvm._msRootHandles) {
        jvm._msRootHandles = new Map();
        jvm._nextMsRootHandle = 1;
      }
      const handle = jvm._nextMsRootHandle++;
      jvm._msRootHandles.set(handle, value);
      return handle;
    },
  },
};

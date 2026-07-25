module.exports = {
  super: 'java/lang/Object',
  methods: {
    '<init>()V': () => {},
    // The FunOrb loader posts custom events / inspects the queue; a permissive
    // no-op queue keeps the applet boot path alive in this headless JVM.
    'postEvent(Ljava/awt/AWTEvent;)V': () => {},
    'peekEvent()Ljava/awt/AWTEvent;': () => null,
    'push(Ljava/awt/EventQueue;)V': () => {},
  },
  staticMethods: {
    'isDispatchThread()Z': () => 0,
    'invokeLater(Ljava/lang/Runnable;)V': async (jvm, obj, args) => {
      const runnable = args[0];
      if (runnable) {
        await jvm.callMethodOnObject?.(runnable, 'run', '()V');
      }
    },
  },
};

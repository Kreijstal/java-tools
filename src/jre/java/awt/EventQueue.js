const eventDispatch = require('./eventDispatch');

module.exports = {
  super: 'java/lang/Object',
  methods: {
    '<init>()V': () => {},
    // The legacy applet loader posts custom events / inspects the queue; a permissive
    // no-op queue keeps the applet boot path alive in this headless JVM.
    'postEvent(Ljava/awt/AWTEvent;)V': () => {},
    'peekEvent()Ljava/awt/AWTEvent;': () => null,
    'push(Ljava/awt/EventQueue;)V': () => {},
  },
  staticMethods: {
    'isDispatchThread()Z': (jvm, obj, args, thread) =>
      (eventDispatch.isDispatchThread(jvm, thread) ? 1 : 0),
    'invokeLater(Ljava/lang/Runnable;)V': async (jvm, obj, args) => {
      await eventDispatch.invokeLater(jvm, args[0], 'run', '()V');
    },
    'invokeAndWait(Ljava/lang/Runnable;)V': async (jvm, obj, args, thread) => {
      await eventDispatch.invokeAndWait(jvm, args[0], thread);
    },
  },
};

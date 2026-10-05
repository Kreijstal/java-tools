const eventDispatch = require('../../java/awt/eventDispatch.js');

module.exports = {
  super: 'java/lang/Object',
  interfaces: ['javax/swing/SwingConstants'],
  staticMethods: {
    'isRightMouseButton(Ljava/awt/event/MouseEvent;)Z': (jvm, obj, args) => {
      const event = args[0];
      return event && event.button === 3 ? 1 : 0;
    },
    'invokeLater(Ljava/lang/Runnable;)V': async (jvm, obj, args) => {
      await eventDispatch.invokeLater(jvm, args[0], 'run', '()V');
    },
    'invokeAndWait(Ljava/lang/Runnable;)V': async (jvm, obj, args, thread) => {
      await eventDispatch.invokeAndWait(jvm, args[0], thread);
    },
    'isEventDispatchThread()Z': (jvm, obj, args, thread) =>
      (eventDispatch.isDispatchThread(jvm, thread) ? 1 : 0),
    'getWindowAncestor(Ljava/awt/Component;)Ljava/awt/Window;': (jvm, obj, args) => {
      let current = args[0] && args[0]._parent;
      while (current && !jvm.isInstanceOf(current._className || current.type, 'java/awt/Window')) {
        current = current._parent;
      }
      return current || null;
    },
  },
};

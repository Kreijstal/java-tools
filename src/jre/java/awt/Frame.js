module.exports = {
  super: 'java/awt/Window',
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj._title = '';
      obj._resizable = true;
      obj._undecorated = false;
      obj._disposed = false;
    },
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj._title = args[0] || '';
      obj._resizable = true;
      obj._undecorated = false;
      obj._disposed = false;
    },
    'setVisible(Z)V': (jvm, obj, args) => {
      obj._visible = !!args[0];
      if (obj._awtElement) {
        obj._awtElement.style.display = obj._visible ? '' : 'none';
      }
    },
    'dispose()V': (jvm, obj, args) => {
      obj._disposed = true;
      obj._visible = false;
      if (obj._awtElement && obj._awtElement.parentNode) {
        obj._awtElement.parentNode.removeChild(obj._awtElement);
      }
    },
    'pack()V': () => {},
    'setResizable(Z)V': (jvm, obj, args) => {
      obj._resizable = !!args[0];
    },
    'setUndecorated(Z)V': (jvm, obj, args) => {
      obj._undecorated = !!args[0];
    },
    'handleEvent(Ljava/awt/Event;)Z': (jvm, obj, args) => 0,
  },
};

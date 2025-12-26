// java.awt.Panel - A simple container for AWT components

module.exports = {
  super: 'java/awt/Container',
  methods: {
    '<init>()V': (jvm, obj, args) => {
      // Initialize as a container
      obj._components = [];
      obj._layout = null;
      if (typeof document !== 'undefined') {
        obj._awtElement = document.createElement('div');
        obj._awtElement.style.boxSizing = 'border-box';
      }
    },

    '<init>(Ljava/awt/LayoutManager;)V': (jvm, obj, args) => {
      const baseInit = jvm._jreFindMethod(obj.type, '<init>', '()V');
      if (baseInit) {
        baseInit(jvm, obj, []);
      }
      if (args[0]) {
        const setLayout = jvm._jreFindMethod(obj.type, 'setLayout', '(Ljava/awt/LayoutManager;)V');
        if (setLayout) {
          setLayout(jvm, obj, [args[0]]);
        }
      }
    },
    
    'add(Ljava/awt/Component;)Ljava/awt/Component;': (jvm, obj, args) => {
      const addMethod = jvm._jreFindMethod('java/awt/Container', 'add', '(Ljava/awt/Component;)Ljava/awt/Component;');
      return addMethod ? addMethod(jvm, obj, args) : args[0];
    },

    'add(Ljava/awt/Component;Ljava/lang/Object;)V': (jvm, obj, args) => {
      const addMethod = jvm._jreFindMethod('java/awt/Container', 'add', '(Ljava/awt/Component;Ljava/lang/Object;)V');
      if (addMethod) {
        addMethod(jvm, obj, args);
      }
    },
    
    'remove(Ljava/awt/Component;)V': (jvm, obj, args) => {
      const removeMethod = jvm._jreFindMethod('java/awt/Container', 'remove', '(Ljava/awt/Component;)V');
      if (removeMethod) {
        removeMethod(jvm, obj, args);
      }
    }
  },
};

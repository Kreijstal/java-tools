// java.awt.Panel - A simple container for AWT components

module.exports = {
  super: 'java/awt/Container',
  methods: {
    '<init>()V': (jvm, obj, args) => {
      // Initialize as a container
      obj._components = [];
    },
    
    'add(Ljava/awt/Component;)Ljava/awt/Component;': (jvm, obj, args) => {
      const component = args[0];
      if (component) {
        obj._components = obj._components || [];
        obj._components.push(component);
        component._parent = obj;
      }
      return component;
    },
    
    'remove(Ljava/awt/Component;)V': (jvm, obj, args) => {
      const component = args[0];
      if (component && obj._components) {
        const index = obj._components.indexOf(component);
        if (index !== -1) {
          obj._components.splice(index, 1);
          component._parent = null;
        }
      }
    }
  },
};
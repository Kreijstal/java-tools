// java.awt.Container - Base class for AWT containers

module.exports = {
  super: 'java/awt/Component',
  methods: {
    '<init>()V': (jvm, obj, args) => {
      // Initialize as a component
      obj._components = [];
      obj._visible = true;
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
    },
    
    'getComponentCount()I': (jvm, obj, args) => {
      return obj._components ? obj._components.length : 0;
    },
    
    'getComponent(I)Ljava/awt/Component;': (jvm, obj, args) => {
      const index = args[0];
      if (obj._components && index >= 0 && index < obj._components.length) {
        return obj._components[index];
      }
      return null;
    }
  },
};
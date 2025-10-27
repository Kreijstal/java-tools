module.exports = {
  super: 'java/awt/Container',
  methods: {
    '<init>()V': (jvm, obj) => {
      obj._components = [];
      obj._background = null;
      obj._foreground = { r: 0, g: 0, b: 0 };
      obj._preferredSize = null;
    },

    'setBackground(Ljava/awt/Color;)V': (jvm, obj, args) => {
      const color = args[0];
      obj._background = color ? color.value || color : null;
    },

    'getBackground()Ljava/awt/Color;': (jvm, obj) => {
      if (!obj._background) {
        return null;
      }
      return { type: 'java/awt/Color', value: obj._background };
    },

    'setForeground(Ljava/awt/Color;)V': (jvm, obj, args) => {
      const color = args[0];
      obj._foreground = color ? color.value || color : { r: 0, g: 0, b: 0 };
    },

    'getForeground()Ljava/awt/Color;': (jvm, obj) => {
      return { type: 'java/awt/Color', value: obj._foreground || { r: 0, g: 0, b: 0 } };
    },

    'setPreferredSize(Ljava/awt/Dimension;)V': (jvm, obj, args) => {
      const dim = args[0];
      if (dim) {
        obj._preferredSize = { width: dim.width || 0, height: dim.height || 0 };
      }
    },

    'getPreferredSize()Ljava/awt/Dimension;': (jvm, obj) => {
      const width = obj._preferredSize ? obj._preferredSize.width : obj._width || 0;
      const height = obj._preferredSize ? obj._preferredSize.height : obj._height || 0;
      return { type: 'java/awt/Dimension', width, height };
    },

    'add(Ljava/awt/Component;)Ljava/awt/Component;': (jvm, obj, args) => {
      const component = args[0];
      if (!component) {
        return null;
      }
      obj._components = obj._components || [];
      obj._components.push(component);
      component._parent = obj;
      return component;
    },

    'remove(Ljava/awt/Component;)V': (jvm, obj, args) => {
      const component = args[0];
      if (!component || !obj._components) {
        return;
      }
      const index = obj._components.indexOf(component);
      if (index !== -1) {
        obj._components.splice(index, 1);
        component._parent = null;
      }
    },

    'paintComponent(Ljava/awt/Graphics;)V': (jvm, obj, args) => {
      const graphicsObj = args[0];
      if (!graphicsObj || !graphicsObj._awtGraphics) {
        return;
      }
      if (obj._background) {
        const g = graphicsObj._awtGraphics;
        if (g.setColor && g.fillRect) {
          g.setColor(obj._background);
          g.fillRect(obj._x || 0, obj._y || 0, obj._width || 0, obj._height || 0);
        }
      }
    },

    'paintChildren(Ljava/awt/Graphics;)V': (jvm, obj, args) => {
      const graphicsObj = args[0];
      if (!graphicsObj) {
        return;
      }
      if (!obj._components) {
        return;
      }
      for (const child of obj._components) {
        if (child && child['paint(Ljava/awt/Graphics;)V']) {
          child['paint(Ljava/awt/Graphics;)V'](jvm, child, args);
        }
      }
    },

    'paint(Ljava/awt/Graphics;)V': (jvm, obj, args) => {
      if (obj['paintComponent(Ljava/awt/Graphics;)V']) {
        obj['paintComponent(Ljava/awt/Graphics;)V'](jvm, obj, args);
      }
      if (obj['paintChildren(Ljava/awt/Graphics;)V']) {
        obj['paintChildren(Ljava/awt/Graphics;)V'](jvm, obj, args);
      }
    },
  },
};

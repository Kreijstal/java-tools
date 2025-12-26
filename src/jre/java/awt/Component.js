// java.awt.Component - Base class for all AWT components
const awtFramework = require('../../../awt.js');

module.exports = {
  super: 'java/lang/Object',
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj._visible = true;
      obj._x = 0;
      obj._y = 0;
      obj._width = 0;
      obj._height = 0;
      obj._parent = null;
    },
    
    'paint(Ljava/awt/Graphics;)V': (jvm, obj, args) => {
      // Default implementation - should be overridden
    },
    
    'update(Ljava/awt/Graphics;)V': (jvm, obj, args) => {
      // Default update calls paint
      if (obj['paint(Ljava/awt/Graphics;)V']) {
        obj['paint(Ljava/awt/Graphics;)V'](jvm, obj, args);
      }
    },
    
    'repaint()V': (jvm, obj, args) => {
      // Trigger repaint - simplified implementation
      const graphics = obj.getGraphics ? obj.getGraphics() : null;
      if (graphics) {
        obj['update(Ljava/awt/Graphics;)V'](jvm, obj, [graphics]);
      }
    },
    
    'setVisible(Z)V': (jvm, obj, args) => {
      obj._visible = args[0];
      if (obj._awtElement) {
        obj._awtElement.style.display = obj._visible ? '' : 'none';
      }
    },
    
    'isVisible()Z': (jvm, obj, args) => {
      return obj._visible;
    },
    
    'setLocation(II)V': (jvm, obj, args) => {
      obj._x = args[0];
      obj._y = args[1];
      if (obj._awtElement) {
        obj._awtElement.style.position = 'absolute';
        obj._awtElement.style.left = `${obj._x}px`;
        obj._awtElement.style.top = `${obj._y}px`;
      }
    },
    
    'setSize(II)V': (jvm, obj, args) => {
      obj._width = args[0];
      obj._height = args[1];
      if (obj._awtComponent && typeof obj._awtComponent.setSize === 'function') {
        obj._awtComponent.setSize(obj._width, obj._height);
      }
      if (obj._canvasElement) {
        obj._canvasElement.width = obj._width;
        obj._canvasElement.height = obj._height;
      }
      if (obj._awtElement) {
        obj._awtElement.style.width = `${obj._width}px`;
        obj._awtElement.style.height = `${obj._height}px`;
      }
    },

    'setBounds(IIII)V': (jvm, obj, args) => {
      obj._x = args[0];
      obj._y = args[1];
      obj._width = args[2];
      obj._height = args[3];
      if (obj._awtComponent && typeof obj._awtComponent.setSize === 'function') {
        obj._awtComponent.setSize(obj._width, obj._height);
      }
      if (obj._canvasElement) {
        obj._canvasElement.width = obj._width;
        obj._canvasElement.height = obj._height;
      }
      if (obj._awtElement) {
        obj._awtElement.style.position = 'absolute';
        obj._awtElement.style.left = `${obj._x}px`;
        obj._awtElement.style.top = `${obj._y}px`;
        obj._awtElement.style.width = `${obj._width}px`;
        obj._awtElement.style.height = `${obj._height}px`;
      }
    },
    
    'getWidth()I': (jvm, obj, args) => {
      if (obj._width) {
        return obj._width;
      }
      if (obj._canvasElement && obj._canvasElement.width) {
        return obj._canvasElement.width;
      }
      if (obj._awtElement && typeof obj._awtElement.getBoundingClientRect === 'function') {
        return Math.floor(obj._awtElement.getBoundingClientRect().width);
      }
      return 0;
    },
    
    'getHeight()I': (jvm, obj, args) => {
      if (obj._height) {
        return obj._height;
      }
      if (obj._canvasElement && obj._canvasElement.height) {
        return obj._canvasElement.height;
      }
      if (obj._awtElement && typeof obj._awtElement.getBoundingClientRect === 'function') {
        return Math.floor(obj._awtElement.getBoundingClientRect().height);
      }
      return 0;
    },
    
    'getX()I': (jvm, obj, args) => {
      return obj._x || 0;
    },
    
    'getY()I': (jvm, obj, args) => {
      return obj._y || 0;
    },
    
    'getParent()Ljava/awt/Container;': (jvm, obj, args) => {
      return obj._parent || null;
    },

    'setPreferredSize(Ljava/awt/Dimension;)V': (jvm, obj, args) => {
      const dim = args[0];
      if (dim) {
        obj._preferredSize = { width: dim.width, height: dim.height };
        if (obj._awtElement) {
          obj._awtElement.style.width = `${dim.width}px`;
          obj._awtElement.style.height = `${dim.height}px`;
        }
      }
    },

    'getPreferredSize()Ljava/awt/Dimension;': (jvm, obj, args) => {
      if (obj._preferredSize) {
        return { type: 'java/awt/Dimension', width: obj._preferredSize.width, height: obj._preferredSize.height };
      }
      return { type: 'java/awt/Dimension', width: obj._width || 0, height: obj._height || 0 };
    },

    'createImage(II)Ljava/awt/Image;': (jvm, obj, args) => {
      const width = args[0];
      const height = args[1];
      const imageImpl = typeof document !== 'undefined'
        ? new awtFramework.CanvasImage(width, height)
        : new awtFramework.MockImage(width, height);
      return { type: 'java/awt/Image', _awtImage: imageImpl };
    }
  },
};

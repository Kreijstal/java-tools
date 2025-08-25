// java.awt.Component - Base class for all AWT components

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
    },
    
    'isVisible()Z': (jvm, obj, args) => {
      return obj._visible;
    },
    
    'setLocation(II)V': (jvm, obj, args) => {
      obj._x = args[0];
      obj._y = args[1];
    },
    
    'setSize(II)V': (jvm, obj, args) => {
      obj._width = args[0];
      obj._height = args[1];
    },
    
    'getWidth()I': (jvm, obj, args) => {
      return obj._width || 0;
    },
    
    'getHeight()I': (jvm, obj, args) => {
      return obj._height || 0;
    },
    
    'getX()I': (jvm, obj, args) => {
      return obj._x || 0;
    },
    
    'getY()I': (jvm, obj, args) => {
      return obj._y || 0;
    },
    
    'getParent()Ljava/awt/Container;': (jvm, obj, args) => {
      return obj._parent || null;
    }
  },
};
module.exports = {
  super: 'java/awt/Frame',
  methods: {
    '<init>()V': (jvm, obj) => {
      const frameBase = require('../../java/awt/Frame.js');
      frameBase.methods['<init>()V'](jvm, obj);
      obj._layoutPadding = 16;
    },

    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
      const frameBase = require('../../java/awt/Frame.js');
      frameBase.methods['<init>(Ljava/lang/String;)V'](jvm, obj, args);
      obj._layoutPadding = 16;
    },

    'getContentPane()Ljava/awt/Container;': (jvm, obj) => obj,

    'add(Ljava/awt/Component;)Ljava/awt/Component;': (jvm, obj, args) => {
      const frameBase = require('../../java/awt/Frame.js');
      return frameBase.methods['add(Ljava/awt/Component;)Ljava/awt/Component;'](jvm, obj, args);
    },

    'paint(Ljava/awt/Graphics;)V': (jvm, obj, args) => {
      const graphicsObj = args[0];
      if (!graphicsObj || !graphicsObj._awtGraphics) {
        return;
      }
      const g = graphicsObj._awtGraphics;
      if (g.setColor && g.fillRect) {
        g.setColor(obj._backgroundColor || { r: 240, g: 240, b: 240 });
        g.fillRect(0, 0, obj._width || 0, obj._height || 0);
      }

      const padding = obj._layoutPadding || 16;
      const availableWidth = (obj._width || 0) - padding * 2;
      let cursorY = padding;

      const children = obj._components || [];
      for (const child of children) {
        if (!child) {
          continue;
        }
        const preferred = child._preferredSize || { width: availableWidth, height: 40 };
        const childWidth = preferred.width || availableWidth;
        const childHeight = preferred.height || 40;

        child._x = padding;
        child._y = cursorY;
        child._width = childWidth;
        child._height = childHeight;

        cursorY += childHeight + padding;

        if (child['paint(Ljava/awt/Graphics;)V']) {
          child['paint(Ljava/awt/Graphics;)V'](jvm, child, args);
        }
      }
    },
  },
};

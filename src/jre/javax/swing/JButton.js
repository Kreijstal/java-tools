module.exports = {
  super: 'javax/swing/JComponent',
  methods: {
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
      const base = require('./JComponent.js');
      base.methods['<init>()V'](jvm, obj);
      const text = args[0];
      obj._text = text ? String(text) : '';
      obj._preferredSize = { width: obj._text.length * 10 + 24, height: 32 };
      obj._background = { r: 221, g: 221, b: 221 };
    },

    '<init>()V': (jvm, obj) => {
      const base = require('./JComponent.js');
      base.methods['<init>()V'](jvm, obj);
      obj._text = '';
      obj._preferredSize = { width: 80, height: 32 };
      obj._background = { r: 221, g: 221, b: 221 };
    },

    'setText(Ljava/lang/String;)V': (jvm, obj, args) => {
      const text = args[0];
      obj._text = text ? String(text) : '';
      obj._preferredSize = { width: obj._text.length * 10 + 24, height: 32 };
    },

    'getText()Ljava/lang/String;': (jvm, obj) => {
      return jvm.internString(obj._text || '');
    },

    'paintComponent(Ljava/awt/Graphics;)V': (jvm, obj, args) => {
      const graphicsObj = args[0];
      if (!graphicsObj || !graphicsObj._awtGraphics) {
        return;
      }
      const g = graphicsObj._awtGraphics;
      if (g.setColor && g.fillRect) {
        g.setColor(obj._background || { r: 221, g: 221, b: 221 });
        g.fillRect(obj._x || 0, obj._y || 0, obj._width || 0, obj._height || 0);
      }
      if (g.setColor && g.drawRect) {
        g.setColor({ r: 128, g: 128, b: 128 });
        g.drawRect(obj._x || 0, obj._y || 0, obj._width || 0, obj._height || 0);
      }
      if (g.setColor) {
        g.setColor(obj._foreground || { r: 0, g: 0, b: 0 });
      }
      if (g.drawString) {
        const text = obj._text || '';
        const baseline = (obj._y || 0) + Math.max(20, Math.floor((obj._height || 32) * 0.65));
        const textStart = (obj._x || 0) + 12;
        g.drawString(text, textStart, baseline);
      }
    },
  },
};

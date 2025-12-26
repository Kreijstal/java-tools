// Requires AWT framework
const awtFramework = require('../../../awt.js');

module.exports = {
  super: 'java/lang/Object',
  isAbstract: true,
  methods: {
    // Abstract method - implementation should be in subclasses
    'drawString(Ljava/lang/String;II)V': (jvm, obj, args) => {
      // Get the native graphics context from the object
      const graphicsContext = obj._awtGraphics;

      if (graphicsContext && graphicsContext.drawString) {
        graphicsContext.drawString(args[0], args[1], args[2]);
      }
      // No fallback - rely on proper Graphics object creation
    },
    
    'setColor(Ljava/awt/Color;)V': (jvm, obj, args) => {
      const colorObj = args[0];
      const graphicsContext = obj._awtGraphics;
      if (graphicsContext && graphicsContext.setColor && colorObj) {
        const colorValue = (colorObj.value !== undefined) ? colorObj.value : colorObj;
        graphicsContext.setColor(colorValue);
      }
    },
    
    'fillRect(IIII)V': (jvm, obj, args) => {
      const graphicsContext = obj._awtGraphics;
      if (graphicsContext && graphicsContext.fillRect) {
        graphicsContext.fillRect(args[0], args[1], args[2], args[3]);
      }
    },
    
    'drawRect(IIII)V': (jvm, obj, args) => {
      const graphicsContext = obj._awtGraphics;
      if (graphicsContext && graphicsContext.drawRect) {
        graphicsContext.drawRect(args[0], args[1], args[2], args[3]);
      }
    },

    'fillOval(IIII)V': (jvm, obj, args) => {
      const graphicsContext = obj._awtGraphics;
      if (graphicsContext && graphicsContext.fillOval) {
        graphicsContext.fillOval(args[0], args[1], args[2], args[3]);
      }
    },

    'drawOval(IIII)V': (jvm, obj, args) => {
      const graphicsContext = obj._awtGraphics;
      if (graphicsContext && graphicsContext.drawOval) {
        graphicsContext.drawOval(args[0], args[1], args[2], args[3]);
      }
    },
    
    'setFont(Ljava/awt/Font;)V': (jvm, obj, args) => {
      const fontObj = args[0];
      if (fontObj && fontObj.value) {
        const graphicsContext = obj._awtGraphics;
        if (graphicsContext && graphicsContext.setFont) {
          graphicsContext.setFont(fontObj.value);
        }
      }
    },
    
    'dispose()V': (jvm, obj, args) => {
      const graphicsContext = obj._awtGraphics;
      if (graphicsContext && graphicsContext.dispose) {
        graphicsContext.dispose();
      }
    }
  },
};

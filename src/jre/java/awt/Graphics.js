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
      console.log(`🎨 Graphics.drawString called with: text="${args[0]}", x=${args[1]}, y=${args[2]}`);
      console.log(`📋 Graphics context available: ${!!graphicsContext}`);
      console.log(`🔧 drawString method available: ${!!(graphicsContext && graphicsContext.drawString)}`);

      if (graphicsContext && graphicsContext.drawString) {
        console.log(`✅ Executing native drawString implementation`);
        graphicsContext.drawString(args[0], args[1], args[2]);
        console.log(`✅ drawString execution completed`);
      } else {
        console.log(`❌ No graphics context or drawString method available`);
      }
    },
    
    'setColor(Ljava/awt/Color;)V': (jvm, obj, args) => {
      const colorObj = args[0];
      if (colorObj && colorObj.value) {
        const graphicsContext = obj._awtGraphics;
        if (graphicsContext && graphicsContext.setColor) {
          graphicsContext.setColor(colorObj.value);
        }
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
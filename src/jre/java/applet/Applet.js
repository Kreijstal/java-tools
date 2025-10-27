// Requires AWT framework
const awtFramework = require('../../../awt.js');

module.exports = {
  super: 'java/awt/Panel',
  methods: {
    '<init>()V': (jvm, obj, args) => {
      // Initialize applet as a Panel
      obj._awtComponent = new awtFramework.Canvas();
      obj._awtComponent.setSize(800, 600); // Default applet size
      obj._width = 800;
      obj._height = 600;
      obj._canvasElement = null;
    },
    
    'init()V': (jvm, obj, args) => {
      // Default implementation - can be overridden
    },
    
    'start()V': (jvm, obj, args) => {
      // Default implementation - can be overridden
    },
    
    'stop()V': (jvm, obj, args) => {
      // Default implementation - can be overridden
    },
    
    'destroy()V': (jvm, obj, args) => {
      // Default implementation - can be overridden
    },
    
    'paint(Ljava/awt/Graphics;)V': (jvm, obj, args) => {
      // Default implementation - should be overridden by subclasses
      // This is the method that HelloWorld will override
    },
    
    'update(Ljava/awt/Graphics;)V': (jvm, obj, args) => {
      // Default update calls paint
      if (obj['paint(Ljava/awt/Graphics;)V']) {
        obj['paint(Ljava/awt/Graphics;)V'](jvm, obj, args);
      }
    },
    
    'getGraphics()Ljava/awt/Graphics;': (jvm, obj, args) => {
      // Return a Graphics object using JVM's createGraphicsObject method
      return jvm.createGraphicsObject(obj);
    },
    
    'repaint()V': (jvm, obj, args) => {
      if (!obj._awtComponent) {
        return;
      }

      const graphicsObj = jvm.createGraphicsObject(obj);
      if (!graphicsObj) {
        return;
      }

      if (
        graphicsObj._awtGraphics &&
        typeof graphicsObj._awtGraphics.setColor === 'function' &&
        typeof graphicsObj._awtGraphics.fillRect === 'function'
      ) {
        graphicsObj._awtGraphics.setColor({ r: 255, g: 255, b: 255 });
        graphicsObj._awtGraphics.fillRect(0, 0, obj._awtComponent.width || 800, obj._awtComponent.height || 600);
      }

      const paintMethod = jvm.findMethod(
        jvm.classes[obj.type],
        'paint',
        '(Ljava/awt/Graphics;)V',
      );

      if (paintMethod) {
        const Frame = require('../../../frame');
        const paintFrame = new Frame(paintMethod);
        paintFrame.className = obj.type;
        paintFrame.locals[0] = obj;
        paintFrame.locals[1] = graphicsObj;

        const currentThread = jvm.threads[jvm.currentThreadIndex];
        if (currentThread) {
          currentThread.callStack.push(paintFrame);

          const originalStackSize = currentThread.callStack.size();
          let maxIterations = 1000;
          let iterations = 0;

          while (currentThread.callStack.size() >= originalStackSize && iterations < maxIterations) {
            const result = jvm.executeTick();
            iterations++;
            if (result && result.completed) {
              break;
            }
          }
        }
      } else if (obj['paint(Ljava/awt/Graphics;)V']) {
        obj['paint(Ljava/awt/Graphics;)V'](jvm, obj, [graphicsObj]);
      }
    }
  },
};
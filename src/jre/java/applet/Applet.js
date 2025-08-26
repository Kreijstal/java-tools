// Requires AWT framework
const awtFramework = require('../../../awt.js');

module.exports = {
  super: 'java/awt/Panel',
  methods: {
    '<init>()V': (jvm, obj, args) => {
      // Initialize applet as a Panel
      obj._awtComponent = new awtFramework.Canvas();
      obj._awtComponent.setSize(800, 600); // Default applet size
      
      // Create and attach canvas to DOM if in browser environment
      if (typeof document !== 'undefined') {
        const canvas = document.createElement('canvas');
        canvas.width = 800;
        canvas.height = 600;
        canvas.style.border = '1px solid #ccc';
        canvas.style.background = 'white';
        
        // Store reference to canvas element
        obj._awtComponent.canvasElement = canvas;
        obj._canvasElement = canvas;
        
        // Add canvas to DOM - look for AWT container or create one
        let awtContainer = document.getElementById('awt-container');
        if (!awtContainer) {
          awtContainer = document.createElement('div');
          awtContainer.id = 'awt-container';
          awtContainer.style.cssText = 'margin: 10px 0; padding: 10px; border: 1px solid #ddd; background: #f9f9f9;';
          
          // Add title
          const title = document.createElement('h3');
          title.textContent = 'Java AWT/Applet Output';
          title.style.cssText = 'margin: 0 0 10px 0; color: #333;';
          awtContainer.appendChild(title);
          
          // Insert after output section or append to body
          const outputSection = document.getElementById('output')?.parentNode;
          if (outputSection && outputSection.parentNode) {
            outputSection.parentNode.insertBefore(awtContainer, outputSection.nextSibling);
          } else {
            document.body.appendChild(awtContainer);
          }
        }
        
        awtContainer.appendChild(canvas);
        
        console.log('AWT Canvas created and attached to DOM', canvas);
      }
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
      // Trigger a repaint
      if (obj._awtComponent) {
        const graphics = obj._awtComponent.getGraphics();
        if (graphics) {
          // Clear the canvas first
          if (obj._canvasElement) {
            const ctx = obj._canvasElement.getContext('2d');
            if (ctx) {
              ctx.clearRect(0, 0, obj._canvasElement.width, obj._canvasElement.height);
              ctx.fillStyle = 'white';
              ctx.fillRect(0, 0, obj._canvasElement.width, obj._canvasElement.height);
            }
          }
          
          // Create Java Graphics object using JVM's createGraphicsObject method
          const graphicsObj = jvm.createGraphicsObject(obj);
          
          // Call the paint method using JVM method lookup
          const paintMethod = jvm.findMethod(jvm.classes[obj.type], 'paint', '(Ljava/awt/Graphics;)V');
          if (paintMethod) {
            // Execute the actual paint method bytecode
            const Frame = require('../../../frame');
            const paintFrame = new Frame(paintMethod);
            paintFrame.className = obj.type;
            paintFrame.locals[0] = obj; // 'this' parameter
            paintFrame.locals[1] = graphicsObj; // Graphics parameter

            console.log('🎨 Applet.repaint() - Graphics object created:', {
              hasAwtGraphics: !!graphicsObj._awtGraphics,
              graphicsType: graphicsObj.type
            });
            
            // Get current thread to execute the paint method
            const currentThread = jvm.threads[jvm.currentThreadIndex];
            if (currentThread) {
              currentThread.callStack.push(paintFrame);
              
              // Execute the paint method synchronously
              const originalStackSize = currentThread.callStack.size();
              let maxIterations = 1000; // Safety limit
              let iterations = 0;
              
              while (currentThread.callStack.size() >= originalStackSize && iterations < maxIterations) {
                const result = jvm.executeTick();
                iterations++;
                if (result && result.completed) break;
              }
            }
          } else if (obj['paint(Ljava/awt/Graphics;)V']) {
            // Fallback to direct method call
            obj['paint(Ljava/awt/Graphics;)V'](jvm, obj, [graphicsObj]);
          }
        }
      }
    }
  },
};
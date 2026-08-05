// Requires AWT framework
const awtFramework = require('../../../platform/awt.js');
const browserInput = require('../../../platform/browser-awt-input.js');

module.exports = {
  super: 'java/awt/Panel',
  methods: {
    '<init>()V': (jvm, obj, args) => {
      // A page can host several applets, and under the classic plugin applets
      // sharing a codebase shared one VM. Size, parameters, codebase and name
      // therefore cannot live on the JVM -- the second applet would overwrite
      // the first. The embedder stakes a descriptor for the launch it is about
      // to start and this consumes it, so each applet keeps its own.
      const pending = (jvm && jvm._pendingApplet) || null;
      if (jvm) jvm._pendingApplet = null;

      if (pending) {
        if (pending.params) obj._parameters = pending.params;
        if (pending.codeBase) obj._codeBase = pending.codeBase;
        if (pending.documentBase) obj._documentBase = pending.documentBase;
        obj._appletName = pending.name || null;
      }

      // Register for AppletContext.getApplet(name)/getApplets(): applets on one
      // page could find and call each other, which is why <applet name=...>
      // existed. Only meaningful because they share this JVM.
      if (jvm) {
        if (!jvm._appletRegistry) jvm._appletRegistry = [];
        jvm._appletRegistry.push(obj);
      }

      // Initialize applet as a Panel
      const width = (pending && pending.width) || (jvm && jvm._appletWidth) || 800;
      const height = (pending && pending.height) || (jvm && jvm._appletHeight) || 600;
      obj._awtComponent = new awtFramework.Canvas();
      obj._awtComponent.setSize(width, height);
      obj._width = width;
      obj._height = height;
      
      // Create and attach canvas to DOM if in browser environment
      if (typeof document !== 'undefined') {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.style.border = '1px solid #ccc';
        canvas.style.background = 'white';
        // Keep the synthetic applet surface out of the applet's own layout and
        // behind its real components: components added by the applet (panels,
        // canvases) flow in the container's grid above this backdrop canvas.
        canvas.style.position = 'absolute';
        canvas.style.left = '0';
        canvas.style.top = '0';
        canvas.style.zIndex = '-1';
        
        // Store reference to canvas element
        obj._awtComponent.canvasElement = canvas;
        obj._canvasElement = canvas;
        jvm._awtCanvasElement = canvas;
        browserInput.attachBrowserInput(jvm, canvas);
        
        // Add canvas to DOM. An embedder that hosts several applets supplies a
        // container per applet; without one, fall back to the page-global
        // element the debug UI uses. That global lookup is why two applets used
        // to land in the same div, the second reusing the first's root below.
        let awtContainer = (pending && pending.container) ||
          (jvm && jvm._appletContainer) || null;
        if (!awtContainer) {
          awtContainer = document.getElementById('awt-container');
        }
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

        let appletRoot = awtContainer.querySelector('.awt-applet-root');
        if (!appletRoot) {
          appletRoot = document.createElement('div');
          appletRoot.className = 'awt-applet-root';
          appletRoot.style.position = 'relative';
          appletRoot.style.zIndex = '0';
          appletRoot.style.boxSizing = 'border-box';
          awtContainer.appendChild(appletRoot);
        }

        obj._awtElement = appletRoot;
        if (obj._width) {
          appletRoot.style.minWidth = `${obj._width}px`;
        }
        if (obj._height) {
          appletRoot.style.minHeight = `${obj._height}px`;
        }
        if (!appletRoot.contains(canvas)) {
          appletRoot.appendChild(canvas);
        }
        canvas.style.display = 'block';

        if (!obj._clickListenerAttached) {
          obj._clickListenerAttached = true;
          canvas.addEventListener('click', async (event) => {
            const rect = canvas.getBoundingClientRect();
            const clickX = Math.floor(event.clientX - rect.left);
            const clickY = Math.floor(event.clientY - rect.top);

            const method = await jvm.findMethodInHierarchy(obj.type, 'handleClick', '(II)V');
            if (!method) {
              return;
            }

            const Frame = require('../../../core/frame');
            const clickFrame = new Frame(method);
            clickFrame.className = obj.type;
            clickFrame.locals[0] = obj;
            clickFrame.locals[1] = clickX;
            clickFrame.locals[2] = clickY;

            const currentThread = jvm.threads[jvm.currentThreadIndex] || jvm.threads[0];
            if (currentThread) {
              const threadIndex = jvm.threads.indexOf(currentThread);
              if (threadIndex >= 0) {
                jvm.currentThreadIndex = threadIndex;
              }
              const { runFrame } = require('../awt/legacyEvents');
              await runFrame(jvm, clickFrame, {
                thread: currentThread,
                maxIterations: 500000,
                label: `${obj.type}.handleClick`,
              });
            }
          });
        }
        
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

    'getAppletContext()Ljava/applet/AppletContext;': (jvm, obj, args) => {
      if (!obj._appletContext) {
        // Bound to this JVM so the context can reach the applet registry that
        // getApplet()/getApplets() read.
        obj._appletContext = { type: 'java/applet/AppletContext', _jvm: jvm };
      }
      return obj._appletContext;
    },

    'getCodeBase()Ljava/net/URL;': (jvm, obj, args) => {
      const base = obj._codeBase || 'http://localhost/';
      return { type: 'java/net/URL', url: jvm.internString(String(base)) };
    },

    'getDocumentBase()Ljava/net/URL;': (jvm, obj, args) => {
      const base = obj._documentBase || obj._codeBase || 'http://localhost/';
      return { type: 'java/net/URL', url: jvm.internString(String(base)) };
    },

    'getParameter(Ljava/lang/String;)Ljava/lang/String;': (jvm, obj, args) => {
      const params = obj._parameters || {};
      const value = params[String(args[0] || '')];
      return value == null ? null : jvm.internString(String(value));
    },
    
    'repaint()V': async (jvm, obj, args) => {
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
          const paintMethod = await jvm.findMethodInHierarchy(
            obj.type, 'paint', '(Ljava/awt/Graphics;)V');
          const { isJreDefault, runFrame } = require('../awt/legacyEvents');
          if (paintMethod && !isJreDefault(paintMethod)) {
            // Execute the actual paint method bytecode
            const Frame = require('../../../core/frame');
            const paintFrame = new Frame(paintMethod);
            paintFrame.className = obj.type;
            paintFrame.locals[0] = obj; // 'this' parameter
            paintFrame.locals[1] = graphicsObj; // Graphics parameter

            console.log('🎨 Applet.repaint() - Graphics object created:', {
              hasAwtGraphics: !!graphicsObj._awtGraphics,
              graphicsType: graphicsObj.type
            });
            
            // Get current thread to execute the paint method
            const currentThread = jvm.threads[jvm.currentThreadIndex] || jvm.threads[0];
            if (currentThread) {
              await runFrame(jvm, paintFrame, {
                thread: currentThread,
                maxIterations: 500000,
                label: `${obj.type}.paint`,
              });
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

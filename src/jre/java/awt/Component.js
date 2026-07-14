// java.awt.Component - Base class for all AWT components
const awtFramework = require('../../../platform/awt.js');

module.exports = {
  super: 'java/lang/Object',
  interfaces: ['java/awt/image/ImageObserver'],
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj._visible = true;
      obj._x = 0;
      obj._y = 0;
      obj._width = 0;
      obj._height = 0;
      obj._parent = null;
      obj._listeners = {};
      obj._enabled = true;
    },

    'getPeer()Ljava/lang/Object;': (jvm, obj, args) => {
      if (!obj._peer) {
        const hwnd = allocateComponentHandle(jvm, obj);
        obj._peer = {
          type: 'com/ms/awt/WComponentPeer',
          _component: obj,
          _hwnd: hwnd,
          'getHwnd()I': () => hwnd,
          'getTopHwnd()I': () => hwnd,
        };
      }
      return obj._peer;
    },

    'getToolkit()Ljava/awt/Toolkit;': (jvm, obj, args) => {
      const toolkit = jvm._jreFindMethod('java/awt/Toolkit', 'getDefaultToolkit', '()Ljava/awt/Toolkit;');
      return toolkit ? toolkit(jvm, null, []) : { type: 'java/awt/Toolkit' };
    },

    'setCursor(Ljava/awt/Cursor;)V': (jvm, obj, args) => {
      obj._cursor = args[0] || null;
    },

    'getGraphics()Ljava/awt/Graphics;': (jvm, obj, args) => {
      if (obj._awtGraphics) {
        return { type: 'java/awt/Graphics', _awtGraphics: obj._awtGraphics, _component: obj };
      }
      if (obj._awtComponent && typeof obj._awtComponent.getGraphics === 'function') {
        const g = obj._awtComponent.getGraphics();
        if (g) {
          return { type: 'java/awt/Graphics', _awtGraphics: g, _component: obj };
        }
      }
      if (obj._canvasElement && typeof obj._canvasElement.getContext === 'function') {
        const context = obj._canvasElement.getContext('2d');
        if (context) {
          return { type: 'java/awt/Graphics', _awtGraphics: new awtFramework.CanvasGraphics(context), _component: obj };
        }
      }
      // Headless: hand out a context-less Graphics tied to the component so
      // raster blits (drawImage of a BufferedImage framebuffer) still land.
      return { type: 'java/awt/Graphics', _component: obj };
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

    'setBackground(Ljava/awt/Color;)V': (jvm, obj, args) => {
      obj._background = args[0] || null;
      const color = obj._background && (obj._background.value || obj._background);
      if (obj._awtElement && color) {
        obj._awtElement.style.backgroundColor = `rgba(${color.r || 0}, ${color.g || 0}, ${color.b || 0}, ${(color.a == null ? 255 : color.a) / 255})`;
      }
    },

    'getBackground()Ljava/awt/Color;': (jvm, obj, args) => {
      return obj._background || getStaticColor(jvm, 'white');
    },

    'setForeground(Ljava/awt/Color;)V': (jvm, obj, args) => {
      obj._foreground = args[0] || null;
    },

    'getForeground()Ljava/awt/Color;': (jvm, obj, args) => {
      return obj._foreground || getStaticColor(jvm, 'black');
    },

    'show()V': (jvm, obj, args) => {
      obj._visible = true;
      if (obj._awtElement) {
        obj._awtElement.style.display = '';
      }
    },

    'hide()V': (jvm, obj, args) => {
      obj._visible = false;
      if (obj._awtElement) {
        obj._awtElement.style.display = 'none';
      }
    },

    'enable()V': (jvm, obj, args) => {
      obj._enabled = true;
    },

    'disable()V': (jvm, obj, args) => {
      obj._enabled = false;
    },

    'toFront()V': (jvm, obj, args) => {
      if (obj._awtElement && obj._awtElement.parentNode) {
        obj._awtElement.parentNode.appendChild(obj._awtElement);
      }
    },

    'requestFocus()Z': (jvm, obj, args) => {
      if (obj._awtElement && typeof obj._awtElement.focus === 'function') {
        obj._awtElement.focus();
      }
      return 1;
    },

    'setFocusTraversalKeysEnabled(Z)V': (jvm, obj, args) => {
      obj._focusTraversalKeysEnabled = !!args[0];
    },

    'enableInputMethods(Z)V': (jvm, obj, args) => {
      obj._inputMethodsEnabled = !!args[0];
    },
    
    'isVisible()Z': (jvm, obj, args) => {
      return obj._visible;
    },

    'requestFocus()V': (jvm, obj, args) => {
      obj._focused = true;
    },

    'requestFocusInWindow()Z': (jvm, obj, args) => {
      obj._focused = true;
      return 1;
    },

    'hasFocus()Z': (jvm, obj, args) => {
      return obj._focused ? 1 : 0;
    },

    'isDisplayable()Z': (jvm, obj, args) => 1,

    'isShowing()Z': (jvm, obj, args) => (obj._visible === false ? 0 : 1),
    
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
    
    'getLocationOnScreen()Ljava/awt/Point;': (jvm, obj) => ({
      type: 'java/awt/Point',
      x: obj.x || 0,
      y: obj.y || 0,
    }),
    'getLocation()Ljava/awt/Point;': (jvm, obj) => ({
      type: 'java/awt/Point',
      x: obj.x || 0,
      y: obj.y || 0,
    }),
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
        return makeDimension(obj._preferredSize.width, obj._preferredSize.height);
      }
      return makeDimension(obj._width || 0, obj._height || 0);
    },

    'createImage(II)Ljava/awt/Image;': (jvm, obj, args) => {
      const width = args[0];
      const height = args[1];
      const imageImpl = new awtFramework.CanvasImage(width, height);
      return { type: 'java/awt/Image', _awtImage: imageImpl };
    },

    'getSize()Ljava/awt/Dimension;': (jvm, obj) => makeDimension(obj._width || 0, obj._height || 0),

    'getTreeLock()Ljava/lang/Object;': (jvm, obj) => obj._treeLock || obj,

    'createImage(Ljava/awt/image/ImageProducer;)Ljava/awt/Image;': (jvm, obj, args) => {
      return null;
    },

    'prepareImage(Ljava/awt/Image;Ljava/awt/image/ImageObserver;)Z': (jvm, obj, args) => {
      return 1;
    },

    'imageUpdate(Ljava/awt/Image;IIIII)Z': (jvm, obj, args) => {
      return 0;
    },

    'addKeyListener(Ljava/awt/event/KeyListener;)V': (jvm, obj, args) => addListener(obj, 'key', args[0]),
    'removeKeyListener(Ljava/awt/event/KeyListener;)V': (jvm, obj, args) => removeListener(obj, 'key', args[0]),
    'addFocusListener(Ljava/awt/event/FocusListener;)V': (jvm, obj, args) => addListener(obj, 'focus', args[0]),
    'removeFocusListener(Ljava/awt/event/FocusListener;)V': (jvm, obj, args) => removeListener(obj, 'focus', args[0]),
    'addMouseListener(Ljava/awt/event/MouseListener;)V': (jvm, obj, args) => addListener(obj, 'mouse', args[0]),
    'removeMouseListener(Ljava/awt/event/MouseListener;)V': (jvm, obj, args) => removeListener(obj, 'mouse', args[0]),
    'addMouseMotionListener(Ljava/awt/event/MouseMotionListener;)V': (jvm, obj, args) => addListener(obj, 'mouseMotion', args[0]),
    'removeMouseMotionListener(Ljava/awt/event/MouseMotionListener;)V': (jvm, obj, args) => removeListener(obj, 'mouseMotion', args[0]),
    'addMouseWheelListener(Ljava/awt/event/MouseWheelListener;)V': (jvm, obj, args) => addListener(obj, 'mouseWheel', args[0]),
    'removeMouseWheelListener(Ljava/awt/event/MouseWheelListener;)V': (jvm, obj, args) => removeListener(obj, 'mouseWheel', args[0]),
    'addComponentListener(Ljava/awt/event/ComponentListener;)V': (jvm, obj, args) => addListener(obj, 'component', args[0]),
    'removeComponentListener(Ljava/awt/event/ComponentListener;)V': (jvm, obj, args) => removeListener(obj, 'component', args[0]),
  },
};

function getStaticColor(jvm, name) {
  const key = `${name}:Ljava/awt/Color;`;
  const colorClass = jvm.classes && jvm.classes['java/awt/Color'];
  return colorClass && colorClass.staticFields ? colorClass.staticFields.get(key) : null;
}

function makeDimension(width, height) {
  return {
    type: 'java/awt/Dimension',
    width,
    height,
    fields: {
      'java/awt/Dimension.width': width,
      'java/awt/Dimension.height': height,
    },
  };
}

function addListener(obj, kind, listener) {
  if (!listener) return;
  obj._listeners = obj._listeners || {};
  obj._listeners[kind] = obj._listeners[kind] || [];
  if (!obj._listeners[kind].includes(listener)) {
    obj._listeners[kind].push(listener);
  }
}

function removeListener(obj, kind, listener) {
  if (!obj._listeners || !obj._listeners[kind]) return;
  const index = obj._listeners[kind].indexOf(listener);
  if (index !== -1) {
    obj._listeners[kind].splice(index, 1);
  }
}

function allocateComponentHandle(jvm, component) {
  if (!jvm._awtComponentHandles) {
    jvm._awtComponentHandles = new Map();
    jvm._nextAwtComponentHandle = 1;
  }
  for (const [handle, existing] of jvm._awtComponentHandles) {
    if (existing === component) return handle;
  }
  const handle = jvm._nextAwtComponentHandle++;
  jvm._awtComponentHandles.set(handle, component);
  return handle;
}

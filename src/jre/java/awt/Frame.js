const awtFramework = require('../../../awt.js');

function ensureCanvasElement(frameObj) {
  if (typeof document === 'undefined') {
    return;
  }

  if (frameObj._canvasElement) {
    return;
  }

  const canvas = document.createElement('canvas');
  canvas.width = frameObj._width || 800;
  canvas.height = frameObj._height || 600;
  canvas.style.border = '1px solid #888';
  canvas.style.background = 'white';

  let container = document.getElementById('swing-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'swing-container';
    container.style.cssText = 'margin: 10px 0; padding: 10px; border: 1px solid #ddd; background: #f4f4f4;';

    const title = document.createElement('h3');
    title.textContent = 'Swing Canvas Output';
    title.style.cssText = 'margin: 0 0 10px; font-family: sans-serif; color: #333;';
    container.appendChild(title);

    if (typeof document !== 'undefined' && document.body) {
      document.body.appendChild(container);
    }
  }

  container.appendChild(canvas);

  frameObj._canvasElement = canvas;
  frameObj._awtComponent.setCanvasElement(canvas);
}

module.exports = {
  super: 'java/awt/Container',
  methods: {
    '<init>()V': (jvm, obj) => {
      obj._title = '';
      obj._visible = false;
      obj._width = 800;
      obj._height = 600;
      obj._components = [];
      obj._awtComponent = new awtFramework.Canvas();
      obj._awtComponent.setSize(obj._width, obj._height);
      obj._backgroundColor = { r: 240, g: 240, b: 240 };
    },

    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
      const title = args[0];
      module.exports.methods['<init>()V'](jvm, obj);
      obj._title = title ? String(title) : '';
    },

    'setTitle(Ljava/lang/String;)V': (jvm, obj, args) => {
      const title = args[0];
      obj._title = title ? String(title) : '';
    },

    'getTitle()Ljava/lang/String;': (jvm, obj) => {
      return jvm.internString(obj._title || '');
    },

    'setSize(II)V': (jvm, obj, args) => {
      obj._width = args[0];
      obj._height = args[1];
      if (obj._awtComponent) {
        obj._awtComponent.setSize(obj._width, obj._height);
      }
      if (obj._canvasElement) {
        obj._canvasElement.width = obj._width;
        obj._canvasElement.height = obj._height;
      }
    },

    'setVisible(Z)V': (jvm, obj, args) => {
      obj._visible = !!args[0];
      if (obj._visible) {
        ensureCanvasElement(obj);
        obj.repaint && obj.repaint();
      }
    },

    'isVisible()Z': (jvm, obj) => (obj._visible ? 1 : 0),

    'add(Ljava/awt/Component;)Ljava/awt/Component;': (jvm, obj, args) => {
      const component = args[0];
      if (!component) {
        return null;
      }
      obj._components = obj._components || [];
      obj._components.push(component);
      component._parent = obj;
      return component;
    },

    'remove(Ljava/awt/Component;)V': (jvm, obj, args) => {
      const component = args[0];
      if (!component || !obj._components) {
        return;
      }
      const index = obj._components.indexOf(component);
      if (index !== -1) {
        obj._components.splice(index, 1);
        component._parent = null;
      }
    },

    'getComponentCount()I': (jvm, obj) => {
      return obj._components ? obj._components.length : 0;
    },

    'getGraphics()Ljava/awt/Graphics;': (jvm, obj) => {
      return jvm.createGraphicsObject(obj);
    },

    'repaint()V': (jvm, obj) => {
      const graphics = jvm.createGraphicsObject(obj);
      if (!graphics) {
        return;
      }
      if (obj['paint(Ljava/awt/Graphics;)V']) {
        obj['paint(Ljava/awt/Graphics;)V'](jvm, obj, [graphics]);
      }
    },

    'paint(Ljava/awt/Graphics;)V': (jvm, obj, args) => {
      const graphicsObj = args[0];
      if (!graphicsObj || !graphicsObj._awtGraphics) {
        return;
      }
      const g = graphicsObj._awtGraphics;
      if (g.setColor) {
        g.setColor(obj._backgroundColor || { r: 240, g: 240, b: 240 });
      }
      if (g.fillRect) {
        g.fillRect(0, 0, obj._width || 0, obj._height || 0);
      }
    },
  },
};

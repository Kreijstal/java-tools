// javax.swing.JComponent - base of the lightweight Swing components.
//
// Swing components are DOM elements like their AWT counterparts. A guest
// subclass that overrides paintComponent() gets a <canvas> inside its element,
// and repaint() runs paintComponent() as bytecode against it.

const awtFramework = require('../../../platform/awt.js');
const componentBase = require('../../java/awt/Component.js');
const containerBase = require('../../java/awt/Container.js');

function runtimeClassName(obj) {
  return obj && (obj._className || obj.type);
}

function initComponent(jvm, obj, tagName = 'div') {
  containerBase.methods['<init>()V'](jvm, obj, []);
  obj._opaque = false;
  obj._toolTipText = null;
  obj._border = null;
  if (typeof document !== 'undefined' && !obj._awtElement) {
    const element = document.createElement(tagName);
    element.style.boxSizing = 'border-box';
    obj._awtElement = element;
  }
}

function isGuestOverride(method) {
  return !!(method && method.attributes &&
    method.attributes.some((attribute) => attribute.type === 'code'));
}

function componentSize(obj) {
  const preferred = obj._preferredSize || {};
  return {
    width: obj._width || preferred.width || 0,
    height: obj._height || preferred.height || 0,
  };
}

function ensurePaintCanvas(obj) {
  if (typeof document === 'undefined' || !obj._awtElement) return null;
  const { width, height } = componentSize(obj);
  let canvas = obj._canvasElement;
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    obj._awtElement.insertBefore(canvas, obj._awtElement.firstChild);
    obj._canvasElement = canvas;
  }
  if (width && canvas.width !== width) canvas.width = width;
  if (height && canvas.height !== height) canvas.height = height;
  return canvas;
}

function graphicsFor(jvm, obj) {
  const canvas = ensurePaintCanvas(obj);
  const context = canvas && canvas.getContext && canvas.getContext('2d');
  if (context) {
    return {
      type: 'java/awt/Graphics',
      _awtGraphics: new awtFramework.CanvasGraphics(context),
      _component: obj,
    };
  }
  return { type: 'java/awt/Graphics', _component: obj };
}

/**
 * Paint obj and its children the way Swing does: a guest paint()/update()
 * override wins, otherwise a guest paintComponent() runs on obj's canvas.
 */
async function repaintTree(jvm, obj) {
  if (!obj || obj._visible === false) return;
  const className = runtimeClassName(obj);
  const paint = className && await jvm.findMethodInHierarchy(
    className, 'paint', '(Ljava/awt/Graphics;)V');
  const update = className && await jvm.findMethodInHierarchy(
    className, 'update', '(Ljava/awt/Graphics;)V');
  if (isGuestOverride(paint) || isGuestOverride(update)) {
    await componentBase.methods['repaint()V'](jvm, obj, []);
  } else {
    const paintComponent = className && await jvm.findMethodInHierarchy(
      className, 'paintComponent', '(Ljava/awt/Graphics;)V');
    if (isGuestOverride(paintComponent)) {
      const { runFrame } = require('../../java/awt/legacyEvents');
      const Frame = require('../../../core/frame');
      const frame = new Frame(paintComponent);
      frame.className = className;
      frame.locals[0] = obj;
      frame.locals[1] = graphicsFor(jvm, obj);
      await runFrame(jvm, frame, { label: `${className}.paintComponent` });
    }
  }
  for (const child of obj._components || []) {
    await repaintTree(jvm, child);
  }
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

module.exports = {
  super: 'java/awt/Container',
  initComponent,
  repaintTree,
  methods: {
    '<init>()V': (jvm, obj) => initComponent(jvm, obj),

    'paintComponent(Ljava/awt/Graphics;)V': () => {},
    'paintChildren(Ljava/awt/Graphics;)V': () => {},
    'paintBorder(Ljava/awt/Graphics;)V': () => {},

    'repaint()V': async (jvm, obj) => repaintTree(jvm, obj),
    'repaint(IIII)V': async (jvm, obj) => repaintTree(jvm, obj),
    'repaint(JIIII)V': async (jvm, obj) => repaintTree(jvm, obj),
    'revalidate()V': (jvm, obj) => containerBase.methods['doLayout()V'](jvm, obj, []),
    'validate()V': (jvm, obj) => containerBase.methods['doLayout()V'](jvm, obj, []),
    'invalidate()V': () => {},

    'setOpaque(Z)V': (jvm, obj, args) => { obj._opaque = !!args[0]; },
    'isOpaque()Z': (jvm, obj) => (obj._opaque ? 1 : 0),

    'setBorder(Ljavax/swing/border/Border;)V': (jvm, obj, args) => {
      obj._border = args[0] || null;
    },
    'getBorder()Ljavax/swing/border/Border;': (jvm, obj) => obj._border || null,

    'setToolTipText(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj._toolTipText = args[0] || null;
      if (obj._awtElement) {
        obj._awtElement.title = obj._toolTipText ? String(obj._toolTipText) : '';
      }
    },
    'getToolTipText()Ljava/lang/String;': (jvm, obj) => obj._toolTipText || null,

    'setEnabled(Z)V': (jvm, obj, args) => {
      obj._enabled = !!args[0];
      if (obj._awtElement && 'disabled' in obj._awtElement) {
        obj._awtElement.disabled = !obj._enabled;
      }
    },
    'isEnabled()Z': (jvm, obj) => (obj._enabled === false ? 0 : 1),

    'setFont(Ljava/awt/Font;)V': (jvm, obj, args) => { obj._font = args[0] || null; },
    'getFont()Ljava/awt/Font;': (jvm, obj) => obj._font || null,

    'setForeground(Ljava/awt/Color;)V': (jvm, obj, args) => {
      componentBase.methods['setForeground(Ljava/awt/Color;)V'](jvm, obj, args);
      const color = obj._foreground && (obj._foreground.value || obj._foreground);
      if (obj._awtElement && color) {
        obj._awtElement.style.color = `rgb(${color.r || 0}, ${color.g || 0}, ${color.b || 0})`;
      }
    },

    'setPreferredSize(Ljava/awt/Dimension;)V': (jvm, obj, args) => {
      componentBase.methods['setPreferredSize(Ljava/awt/Dimension;)V'](jvm, obj, args);
      if (obj._canvasElement) ensurePaintCanvas(obj);
    },
    'getPreferredSize()Ljava/awt/Dimension;': (jvm, obj) => {
      if (obj._preferredSize) {
        return makeDimension(obj._preferredSize.width, obj._preferredSize.height);
      }
      const element = obj._awtElement;
      if (element && typeof element.getBoundingClientRect === 'function') {
        const rect = element.getBoundingClientRect();
        if (rect.width || rect.height) {
          return makeDimension(Math.ceil(rect.width), Math.ceil(rect.height));
        }
      }
      return makeDimension(obj._width || 0, obj._height || 0);
    },
  },
};

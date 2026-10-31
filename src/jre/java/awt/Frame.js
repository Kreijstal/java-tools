const componentBase = require('./Component');
const containerBase = require('./Container');

function initFrame(obj, title) {
  obj._title = title;
  obj._resizable = true;
  obj._undecorated = false;
  obj._disposed = false;
  obj._visible = false;
  obj._components = [];
  // Frame defaults to BorderLayout. Leave peer creation lazy so JFrame can
  // create its own title bar and content pane after the Frame constructor.
  obj._layout = { type: 'java/awt/BorderLayout', _hgap: 0, _vgap: 0 };
}

function isHidden(obj) {
  return obj._visible === false || obj._visible === 0;
}

function layoutBorderChildren(jvm, obj) {
  const layout = obj._layout;
  if (!layout || layout.type !== 'java/awt/BorderLayout' ||
      obj._width === undefined || obj._height === undefined) return;
  const width = Math.max(0, obj._width);
  const height = Math.max(0, obj._height);
  const regions = new Map();
  for (const child of obj._components || []) {
    if (!isHidden(child)) regions.set(String(child._layoutConstraint || 'Center').toLowerCase(), child);
  }
  const hgap = layout._hgap || 0;
  const vgap = layout._vgap || 0;
  let left = 0, top = 0, right = width, bottom = height;
  const preferred = (child, axis) => Math.max(0,
    componentBase.methods['getPreferredSize()Ljava/awt/Dimension;'](jvm, child, [])[axis] || 0);
  const place = (child, x, y, w, h) => {
    w = Math.max(0, w); h = Math.max(0, h);
    // Assigning canvas.width/height clears its pixels, even at the same size.
    if (child._x !== x || child._y !== y || child._width !== w || child._height !== h) {
      componentBase.methods['setBounds(IIII)V'](jvm, child, [x, y, w, h]);
    }
    const peer = child._awtElement || child._canvasElement;
    if (peer) {
      peer.style.position = 'absolute';
      peer.style.left = `${x}px`;
      peer.style.top = `${y}px`;
    }
    if (child._components) {
      containerBase.methods['doLayout()V'](jvm, child, []);
      layoutBorderChildren(jvm, child);
    }
  };
  const north = regions.get('north');
  if (north) {
    const h = Math.min(height, preferred(north, 'height'));
    place(north, 0, top, width, h); top += h + vgap;
  }
  const south = regions.get('south');
  if (south) {
    const h = Math.min(Math.max(0, bottom - top), preferred(south, 'height'));
    bottom -= h; place(south, 0, bottom, width, h); bottom -= vgap;
  }
  const east = regions.get('east');
  if (east) {
    const w = Math.min(width, preferred(east, 'width'));
    right -= w; place(east, right, top, w, bottom - top); right -= hgap;
  }
  const west = regions.get('west');
  if (west) {
    const w = Math.min(Math.max(0, right - left), preferred(west, 'width'));
    place(west, left, top, w, bottom - top); left += w + hgap;
  }
  const center = regions.get('center');
  if (center) place(center, left, top, right - left, bottom - top);
  // Native bounds also size each Canvas bitmap. CSS alone cannot do that.
  if (obj._awtElement) obj._awtElement.style.display = isHidden(obj) ? 'none' : 'block';
}

function layoutFrame(jvm, obj) {
  // JFrame owns a separate title-bar/content-pane peer and layout.
  if (obj._contentPane) return;
  containerBase.methods['doLayout()V'](jvm, obj, []);
  const element = obj._awtElement;
  if (element) {
    element.classList.add('jvm-awt-frame');
    element.setAttribute('role', 'group');
    element.setAttribute('aria-label', String(obj._title || ''));
    if (obj._width !== undefined) element.style.width = `${obj._width}px`;
    if (obj._height !== undefined) element.style.height = `${obj._height}px`;
    if (obj._x !== undefined || obj._y !== undefined) {
      element.style.position = 'absolute';
      element.style.left = `${obj._x || 0}px`;
      element.style.top = `${obj._y || 0}px`;
    }
    if (isHidden(obj)) element.style.display = 'none';
  }
  layoutBorderChildren(jvm, obj);
  if (obj._layout === null) {
    for (const child of obj._components || []) {
      const peer = child._awtElement || child._canvasElement;
      if (peer) {
        peer.style.position = 'absolute';
        peer.style.left = `${child._x || 0}px`;
        peer.style.top = `${child._y || 0}px`;
      }
    }
  }
}

async function repaintChildren(jvm, obj) {
  for (const child of obj._components || []) {
    if (isHidden(child)) continue;
    const repaint = jvm._jreFindMethod(child._className || child.type, 'repaint', '()V');
    if (repaint) await repaint(jvm, child, []);
    // Swing's repaintTree already paints its descendants.
    if (child._components && !jvm.isInstanceOf(child._className || child.type, 'javax/swing/JComponent')) {
      await repaintChildren(jvm, child);
    }
  }
}

async function containerCall(jvm, obj, key, args) {
  const result = containerBase.methods[key](jvm, obj, args);
  layoutFrame(jvm, obj);
  if (obj._visible) await repaintChildren(jvm, obj);
  return result;
}

module.exports = {
  super: 'java/awt/Window',
  methods: {
    '<init>()V': (jvm, obj) => initFrame(obj, ''),
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => initFrame(obj, args[0]),
    'setVisible(Z)V': async (jvm, obj, args) => {
      obj._visible = !!args[0];
      if (!obj._visible) {
        if (obj._awtElement) obj._awtElement.style.display = 'none';
        return;
      }
      obj._disposed = false;
      layoutFrame(jvm, obj);
      if (obj._awtElement) {
        const host = document.getElementById('awt-container') || document.body;
        if (host && obj._awtElement.parentNode !== host) host.appendChild(obj._awtElement);
      }
      await repaintChildren(jvm, obj);
    },
    'setSize(II)V': async (jvm, obj, args) => {
      componentBase.methods['setSize(II)V'](jvm, obj, args);
      layoutFrame(jvm, obj);
      if (obj._visible) await repaintChildren(jvm, obj);
    },
    'setBounds(IIII)V': async (jvm, obj, args) => {
      componentBase.methods['setBounds(IIII)V'](jvm, obj, args);
      layoutFrame(jvm, obj);
      if (obj._visible) await repaintChildren(jvm, obj);
    },
    'add(Ljava/awt/Component;)Ljava/awt/Component;': (jvm, obj, args) =>
      containerCall(jvm, obj, 'add(Ljava/awt/Component;)Ljava/awt/Component;', args),
    'add(Ljava/lang/String;Ljava/awt/Component;)Ljava/awt/Component;': (jvm, obj, args) =>
      containerCall(jvm, obj, 'add(Ljava/lang/String;Ljava/awt/Component;)Ljava/awt/Component;', args),
    'add(Ljava/awt/Component;Ljava/lang/Object;)V': (jvm, obj, args) =>
      containerCall(jvm, obj, 'add(Ljava/awt/Component;Ljava/lang/Object;)V', args),
    'remove(Ljava/awt/Component;)V': (jvm, obj, args) =>
      containerCall(jvm, obj, 'remove(Ljava/awt/Component;)V', args),
    'setLayout(Ljava/awt/LayoutManager;)V': (jvm, obj, args) =>
      containerCall(jvm, obj, 'setLayout(Ljava/awt/LayoutManager;)V', args),
    'doLayout()V': (jvm, obj) => layoutFrame(jvm, obj),
    'dispose()V': (jvm, obj) => {
      obj._disposed = true;
      obj._visible = false;
      if (obj._awtElement) {
        obj._awtElement.style.display = 'none';
        if (obj._awtElement.parentNode) obj._awtElement.parentNode.removeChild(obj._awtElement);
      }
    },
    'pack()V': () => {},
    'setTitle(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj._title = args[0] || '';
      if (obj._awtElement) obj._awtElement.setAttribute('aria-label', String(obj._title));
      if (obj._titleElement) obj._titleElement.textContent = String(obj._title);
    },
    'getTitle()Ljava/lang/String;': (jvm, obj) => obj._title || '',
    'isResizable()Z': (jvm, obj) => (obj._resizable === false ? 0 : 1),
    'setResizable(Z)V': (jvm, obj, args) => { obj._resizable = !!args[0]; },
    'setUndecorated(Z)V': (jvm, obj, args) => { obj._undecorated = !!args[0]; },
    'handleEvent(Ljava/awt/Event;)Z': () => 0,
  },
};

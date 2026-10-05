// javax.swing.JFrame - a top-level window with a content pane.
//
// In a browser, setVisible(true) mounts the frame as a window-styled element
// (title bar + content pane) in #awt-container, or in <body> without one.
// Components added to the frame go to its content pane (BorderLayout).

const { makeObjectRef } = require('../../../core/objectModel');
const frameBase = require('../../java/awt/Frame.js');
const containerBase = require('../../java/awt/Container.js');
const { initPanel } = require('./JPanel.js');
const { repaintTree } = require('./JComponent.js');

const DISPOSE_ON_CLOSE = 2;
const EXIT_ON_CLOSE = 3;

function makeContentPane(jvm) {
  const layout = makeObjectRef(jvm, 'java/awt/BorderLayout', {});
  layout._hgap = 0;
  layout._vgap = 0;
  const pane = makeObjectRef(jvm, 'javax/swing/JPanel', {});
  initPanel(jvm, pane, layout);
  return pane;
}

function initFrame(jvm, obj, title) {
  frameBase.methods['<init>(Ljava/lang/String;)V'](jvm, obj, [title || '']);
  obj._components = [];
  obj._visible = false;
  obj._defaultCloseOperation = 1;
  obj._menuBar = null;
  obj._contentPane = makeContentPane(jvm);
  obj._contentPane._parent = obj;
}

function ensureWindowElement(jvm, obj) {
  if (typeof document === 'undefined') return null;
  if (obj._awtElement) return obj._awtElement;
  const win = document.createElement('div');
  win.className = 'jvm-swing-frame';
  win.style.cssText = 'display: inline-flex; flex-direction: column; margin: 8px; ' +
    'border: 1px solid #888; background: #eee; box-shadow: 0 2px 8px rgba(0,0,0,0.3); ' +
    'font: 13px sans-serif; vertical-align: top;';
  const bar = document.createElement('div');
  bar.style.cssText = 'display: flex; align-items: center; padding: 4px 8px; ' +
    'background: #4a6d8c; color: white; user-select: none;';
  const title = document.createElement('span');
  title.style.flex = '1';
  title.textContent = String(obj._title || '');
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.title = 'Close';
  close.style.cssText = 'border: none; background: transparent; color: white; ' +
    'font-size: 16px; cursor: pointer; padding: 0 4px;';
  close.addEventListener('click', () => closeWindow(jvm, obj));
  bar.appendChild(title);
  bar.appendChild(close);
  win.appendChild(bar);
  obj._titleElement = title;
  obj._awtElement = win;
  attachContentPane(obj);
  applySize(obj);
  return win;
}

function attachContentPane(obj) {
  const win = obj._awtElement;
  const paneElement = obj._contentPane && obj._contentPane._awtElement;
  if (!win || !paneElement) return;
  if (obj._paneElement && obj._paneElement !== paneElement &&
      obj._paneElement.parentNode === win) {
    win.removeChild(obj._paneElement);
  }
  paneElement.style.flex = '1';
  paneElement.style.minHeight = '0';
  if (paneElement.parentNode !== win) win.appendChild(paneElement);
  obj._paneElement = paneElement;
}

function applySize(obj) {
  const win = obj._awtElement;
  if (!win) return;
  if (obj._width) win.style.width = `${obj._width}px`;
  if (obj._height) win.style.height = `${obj._height}px`;
}

function closeWindow(jvm, obj) {
  const operation = obj._defaultCloseOperation;
  if (operation === 0) return;
  obj._visible = false;
  if (obj._awtElement) obj._awtElement.style.display = 'none';
  if (operation === DISPOSE_ON_CLOSE || operation === EXIT_ON_CLOSE) {
    frameBase.methods['dispose()V'](jvm, obj, []);
  }
  if (operation === EXIT_ON_CLOSE && typeof jvm.exit === 'function') {
    jvm.exit(0);
  }
}

function mount(obj) {
  const win = obj._awtElement;
  if (!win || win.parentNode) return;
  const host = document.getElementById('awt-container') || document.body;
  if (host) host.appendChild(win);
}

function contentPaneCall(jvm, obj, descriptorName, args) {
  const pane = obj._contentPane;
  const [name, descriptor] = descriptorName;
  const method = jvm._jreFindMethod(pane._className || pane.type, name, descriptor) ||
    containerBase.methods[name + descriptor];
  return method(jvm, pane, args);
}

module.exports = {
  super: 'java/awt/Frame',
  interfaces: ['javax/swing/WindowConstants'],
  staticFields: {
    'EXIT_ON_CLOSE:I': EXIT_ON_CLOSE,
  },
  methods: {
    '<init>()V': (jvm, obj) => initFrame(jvm, obj, ''),
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => initFrame(jvm, obj, args[0]),

    'getContentPane()Ljava/awt/Container;': (jvm, obj) => obj._contentPane,
    'setContentPane(Ljava/awt/Container;)V': (jvm, obj, args) => {
      if (!args[0]) return;
      obj._contentPane = args[0];
      obj._contentPane._parent = obj;
      attachContentPane(obj);
    },

    'add(Ljava/awt/Component;)Ljava/awt/Component;': (jvm, obj, args) =>
      contentPaneCall(jvm, obj, ['add', '(Ljava/awt/Component;)Ljava/awt/Component;'], args),
    'add(Ljava/awt/Component;Ljava/lang/Object;)V': (jvm, obj, args) =>
      contentPaneCall(jvm, obj, ['add', '(Ljava/awt/Component;Ljava/lang/Object;)V'], args),
    'add(Ljava/lang/String;Ljava/awt/Component;)Ljava/awt/Component;': (jvm, obj, args) =>
      contentPaneCall(jvm, obj,
        ['add', '(Ljava/lang/String;Ljava/awt/Component;)Ljava/awt/Component;'], args),
    'remove(Ljava/awt/Component;)V': (jvm, obj, args) =>
      contentPaneCall(jvm, obj, ['remove', '(Ljava/awt/Component;)V'], args),
    'setLayout(Ljava/awt/LayoutManager;)V': (jvm, obj, args) => {
      // Called by Frame's own constructor chain before the pane exists.
      if (!obj._contentPane) return;
      contentPaneCall(jvm, obj, ['setLayout', '(Ljava/awt/LayoutManager;)V'], args);
    },

    'setDefaultCloseOperation(I)V': (jvm, obj, args) => {
      obj._defaultCloseOperation = args[0] | 0;
    },
    'getDefaultCloseOperation()I': (jvm, obj) => obj._defaultCloseOperation | 0,
    'setJMenuBar(Ljavax/swing/JMenuBar;)V': (jvm, obj, args) => { obj._menuBar = args[0] || null; },
    'getJMenuBar()Ljavax/swing/JMenuBar;': (jvm, obj) => obj._menuBar || null,
    'setLocationRelativeTo(Ljava/awt/Component;)V': () => {},

    'setSize(II)V': (jvm, obj, args) => {
      obj._width = args[0];
      obj._height = args[1];
      applySize(obj);
    },
    'setVisible(Z)V': async (jvm, obj, args) => {
      obj._visible = !!args[0];
      const win = ensureWindowElement(jvm, obj);
      if (win) {
        win.style.display = obj._visible ? 'inline-flex' : 'none';
        if (obj._visible) mount(obj);
      }
      if (obj._visible) await repaintTree(jvm, obj._contentPane);
    },
    'repaint()V': async (jvm, obj) => repaintTree(jvm, obj._contentPane),
    'dispose()V': (jvm, obj, args) => frameBase.methods['dispose()V'](jvm, obj, args),
  },
};

// java.awt.Canvas - A component with its own drawing surface.
// Every Canvas gets a real HTML canvas element so paint()/getGraphics()
// target a surface of its own. Mouse interaction is dispatched through the
// legacy pre-1.1 event model (mouseDown/mouseDrag/mouseUp overrides), which
// old applets like NASA's KiteModeler use for zooming and panning.

const awtFramework = require('../../../platform/awt.js');
const browserInput = require('../../../platform/browser-awt-input.js');
const { postMouseEvent } = require('./legacyEvents');

function attachMouseInteraction(jvm, obj, canvas) {
  const toLocal = (e) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.floor(e.clientX - rect.left),
      y: Math.floor(e.clientY - rect.top),
      modifiers: ((e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.altKey ? 8 : 0)),
    };
  };
  let moveDispatching = false;
  let pendingMove = null;
  const reportFailure = (promise) => promise.catch((error) => {
    console.error('AWT Canvas mouse dispatch failed:', error);
    return false;
  });
  const pumpMove = () => {
    if (moveDispatching || !pendingMove) return;
    const move = pendingMove;
    pendingMove = null;
    moveDispatching = true;
    reportFailure(postMouseEvent(
      jvm, obj, move.id, move.x, move.y, move.modifiers, move.clickCount,
    )).finally(() => {
      moveDispatching = false;
      pumpMove();
    });
  };
  canvas.addEventListener('mousedown', (e) => {
    obj._mouseDown = true;
    const { x, y, modifiers } = toLocal(e);
    reportFailure(postMouseEvent(
      jvm, obj, 501, x, y, modifiers, e.detail || 1,
    )); // MOUSE_DOWN
    e.preventDefault();
  });
  canvas.addEventListener('mousemove', (e) => {
    const { x, y, modifiers } = toLocal(e);
    pendingMove = {
      id: obj._mouseDown ? 506 : 503,
      x,
      y,
      modifiers,
      clickCount: e.detail || 0,
    }; // MOUSE_DRAG / MOUSE_MOVE
    pumpMove();
    e.preventDefault();
  });
  canvas.addEventListener('mouseup', (e) => {
    obj._mouseDown = false;
    const { x, y, modifiers } = toLocal(e);
    reportFailure(postMouseEvent(
      jvm, obj, 502, x, y, modifiers, e.detail || 1,
    )); // MOUSE_UP
    e.preventDefault();
  });
  canvas.addEventListener('mouseleave', () => {
    obj._mouseDown = false;
    pendingMove = null;
  });
}

module.exports = {
  super: 'java/awt/Component',
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj._visible = true;
      obj._listeners = {};
      obj._ownerJvm = jvm;
      if (typeof document !== 'undefined') {
        const canvas = document.createElement('canvas');
        canvas.width = obj._width || 800;
        canvas.height = obj._height || 600;
        canvas.style.border = '1px solid #ccc';
        canvas.style.background = 'white';
        canvas.style.display = 'block';
        obj._canvasElement = canvas;
        obj._awtComponent = new awtFramework.Canvas();
        obj._awtComponent.canvasElement = canvas;
        attachMouseInteraction(jvm, obj, canvas);
        // Modern AWT games register MouseListener/MouseMotionListener and
        // KeyListener instances on the concrete Canvas.  Bind this visible
        // DOM surface to that Java component; the applet's backdrop bridge is
        // not an ancestor and therefore cannot observe these browser events.
        browserInput.attachBrowserInput(jvm, canvas, obj);
      }
    },
  },
};

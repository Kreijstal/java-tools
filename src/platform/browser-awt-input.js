const Frame = require('../core/frame');
const Stack = require('../core/stack');

const LISTENER_METHODS = {
  mousePressed: '(Ljava/awt/event/MouseEvent;)V',
  mouseReleased: '(Ljava/awt/event/MouseEvent;)V',
  mouseClicked: '(Ljava/awt/event/MouseEvent;)V',
  mouseEntered: '(Ljava/awt/event/MouseEvent;)V',
  mouseExited: '(Ljava/awt/event/MouseEvent;)V',
  mouseMoved: '(Ljava/awt/event/MouseEvent;)V',
  mouseDragged: '(Ljava/awt/event/MouseEvent;)V',
  mouseWheelMoved: '(Ljava/awt/event/MouseWheelEvent;)V',
  keyPressed: '(Ljava/awt/event/KeyEvent;)V',
  keyReleased: '(Ljava/awt/event/KeyEvent;)V',
  keyTyped: '(Ljava/awt/event/KeyEvent;)V',
  focusGained: '(Ljava/awt/event/FocusEvent;)V',
  focusLost: '(Ljava/awt/event/FocusEvent;)V',
};

function componentRegistry(jvm) {
  if (!jvm._awtInputComponents) jvm._awtInputComponents = new Map();
  return jvm._awtInputComponents;
}

function registerInputComponent(jvm, component, kind) {
  const registry = componentRegistry(jvm);
  if (!registry.has(kind)) registry.set(kind, new Set());
  registry.get(kind).add(component);
}

function unregisterInputComponent(jvm, component, kind) {
  const components = jvm._awtInputComponents && jvm._awtInputComponents.get(kind);
  if (!components || component._listeners?.[kind]?.length) return;
  components.delete(component);
}

function focusInputComponent(jvm, component) {
  jvm._awtFocusedComponent = component;
  const canvas = component?._canvasElement || jvm._awtCanvasElement;
  if (canvas && typeof canvas.focus === 'function') canvas.focus({ preventScroll: true });
  component._focused = true;
}

function modifiers(event, button = 0) {
  let value = 0;
  if (event.shiftKey) value |= 1;
  if (event.ctrlKey) value |= 2;
  if (event.metaKey) value |= 4;
  if (event.altKey) value |= 8;
  if (button === 1 || (event.buttons & 1)) value |= 16;
  if (button === 2 || (event.buttons & 4)) value |= 8;
  if (button === 3 || (event.buttons & 2)) value |= 4;
  return value;
}

function eventPosition(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = rect.width ? canvas.width / rect.width : 1;
  const scaleY = rect.height ? canvas.height / rect.height : 1;
  return {
    x: Math.floor((event.clientX - rect.left) * scaleX),
    y: Math.floor((event.clientY - rect.top) * scaleY),
  };
}

function javaButton(event) {
  return event.button === 0 ? 1 : event.button === 1 ? 2 : event.button === 2 ? 3 : 0;
}

function baseInputEvent(type, source, id, event) {
  return {
    type, source, id,
    when: Date.now(),
    modifiers: modifiers(event),
    shiftDown: Boolean(event.shiftKey),
    controlDown: Boolean(event.ctrlKey),
    altDown: Boolean(event.altKey),
    metaDown: Boolean(event.metaKey),
    consumed: false,
  };
}

function mouseEvent(canvas, source, id, event) {
  const position = eventPosition(canvas, event);
  const button = javaButton(event);
  return {
    ...baseInputEvent('java/awt/event/MouseEvent', source, id, event),
    ...position,
    button,
    modifiers: modifiers(event, button),
    clickCount: event.detail || 1,
    popupTrigger: button === 3,
  };
}

function keyChar(event) {
  if (event.key && event.key.length === 1) return event.key.charCodeAt(0);
  return { Enter: 10, Tab: 9, Backspace: 8, Escape: 27, Delete: 127 }[event.key] ?? 0xffff;
}

function keyEvent(source, id, event) {
  return {
    ...baseInputEvent('java/awt/event/KeyEvent', source, id, event),
    keyCode: event.keyCode || event.which || 0,
    keyChar: keyChar(event),
    keyLocation: event.location || 0,
  };
}

function targets(jvm, kind, focusedOnly = false, source = null) {
  if (source) {
    return source._visible !== false && source._listeners?.[kind]?.length
      ? [source] : [];
  }
  if (focusedOnly && jvm._awtFocusedComponent?._listeners?.[kind]?.length) {
    return [jvm._awtFocusedComponent];
  }
  return [...(jvm._awtInputComponents?.get(kind) || [])]
    .filter(component => component && component._visible !== false);
}

function queueForComponents(jvm, kind, methodName, makeEvent, focusedOnly = false,
  source = null) {
  for (const component of targets(jvm, kind, focusedOnly, source)) {
    const event = makeEvent(component);
    for (const listener of component._listeners?.[kind] || []) {
      jvm.enqueueAwtEventInvocation(listener, methodName,
        LISTENER_METHODS[methodName], event,
        methodName === 'mouseMoved' || methodName === 'mouseDragged');
    }
  }
}

function attachBrowserInput(jvm, canvas, source = null) {
  if (!canvas || canvas._jvmAwtInputAttached || typeof canvas.addEventListener !== 'function') return;
  canvas._jvmAwtInputAttached = true;
  canvas.tabIndex = 0;
  canvas.style.outline = 'none';

  const mouse = (domName, kind, methodName, id) => canvas.addEventListener(domName, event => {
    if (domName === 'mousedown') {
      const preferred = targets(jvm, 'key', false, source)[0] ||
        targets(jvm, kind, false, source)[0];
      if (preferred) focusInputComponent(jvm, preferred);
      else canvas.focus({ preventScroll: true });
    }
    queueForComponents(jvm, kind, methodName,
      component => mouseEvent(canvas, component, id, event), false, source);
    event.preventDefault();
  });
  mouse('mousedown', 'mouse', 'mousePressed', 501);
  mouse('mouseup', 'mouse', 'mouseReleased', 502);
  mouse('click', 'mouse', 'mouseClicked', 500);
  mouse('mouseenter', 'mouse', 'mouseEntered', 504);
  mouse('mouseleave', 'mouse', 'mouseExited', 505);
  canvas.addEventListener('mousemove', event => {
    const dragged = event.buttons !== 0;
    queueForComponents(jvm, 'mouseMotion', dragged ? 'mouseDragged' : 'mouseMoved',
      component => mouseEvent(canvas, component, dragged ? 506 : 503, event),
      false, source);
    event.preventDefault();
  });
  canvas.addEventListener('wheel', event => {
    queueForComponents(jvm, 'mouseWheel', 'mouseWheelMoved', component => ({
      ...mouseEvent(canvas, component, 507, event),
      type: 'java/awt/event/MouseWheelEvent',
      wheelRotation: event.deltaY === 0 ? 0 : event.deltaY > 0 ? 1 : -1,
      preciseWheelRotation: event.deltaY,
      scrollAmount: 1,
    }), false, source);
    event.preventDefault();
  }, { passive: false });
  canvas.addEventListener('keydown', event => {
    queueForComponents(jvm, 'key', 'keyPressed',
      component => keyEvent(component, 401, event), true, source);
    if (keyChar(event) !== 0xffff) {
      queueForComponents(jvm, 'key', 'keyTyped',
        component => keyEvent(component, 400, event), true, source);
    }
    event.preventDefault();
  });
  canvas.addEventListener('keyup', event => {
    queueForComponents(jvm, 'key', 'keyReleased',
      component => keyEvent(component, 402, event), true, source);
    event.preventDefault();
  });
  canvas.addEventListener('focus', event => {
    queueForComponents(jvm, 'focus', 'focusGained', component =>
      baseInputEvent('java/awt/event/FocusEvent', component, 1004, event), true,
      source);
  });
  canvas.addEventListener('blur', event => {
    queueForComponents(jvm, 'focus', 'focusLost', component =>
      baseInputEvent('java/awt/event/FocusEvent', component, 1005, event), true,
      source);
    if (jvm._awtFocusedComponent) jvm._awtFocusedComponent._focused = false;
  });
  canvas.addEventListener('contextmenu', event => event.preventDefault());
}

module.exports = {
  attachBrowserInput,
  focusInputComponent,
  registerInputComponent,
  unregisterInputComponent,
  _test: { eventPosition, javaButton, keyChar, keyEvent, mouseEvent, modifiers },
};

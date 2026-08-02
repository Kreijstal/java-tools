// Legacy (pre-1.1) AWT event dispatch helpers.
//
// Old applets (e.g. NASA's KiteModeler) never use ActionListener. They
// override handleEvent(Event) / action(Event, Object) on their panels and
// rely on Component.postEvent() bubbling a java.awt.Event up the component
// hierarchy. These helpers execute the guest bytecode overrides and capture
// their boolean result so the bubbling can stop once the event is handled.

const Frame = require('../../../core/frame');

function isJreDefault(method) {
  // Guest methods carry a code attribute; JRE methods are plain JS functions.
  if (!method) return true;
  if (typeof method === 'function' && !method.attributes) return true;
  const code = method.attributes && method.attributes.find(a => a.type === 'code');
  return !code;
}

/**
 * Run a guest bytecode method on the current thread and wait for its result.
 * Uses the JVM's reflective-call mechanism so ireturn hands us the value.
 */
async function runGuestMethod(jvm, className, method, locals) {
  const frame = new Frame(method);
  frame.className = className;
  for (let i = 0; i < locals.length; i++) frame.locals[i] = locals[i];

  const thread = jvm.threads[jvm.currentThreadIndex] || jvm.threads[0];
  if (!thread) return false;

  let result = false;
  let resolved = false;
  thread.isAwaitingReflectiveCall = true;
  thread.reflectiveCallFrame = frame;
  thread.reflectiveCallResolver = (value) => {
    resolved = true;
    result = !!value;
  };
  thread.callStack.push(frame);
  thread.status = 'runnable';

  let iterations = 0;
  const maxIterations = 500000;
  while (!resolved && iterations < maxIterations && !thread.callStack.isEmpty()) {
    const r = await jvm.executeTick();
    iterations++;
    if (r && r.completed) break;
  }
  if (!resolved) {
    // Clean up the reflective markers if the method never returned cleanly.
    thread.isAwaitingReflectiveCall = false;
    thread.reflectiveCallResolver = null;
    thread.reflectiveCallFrame = null;
  }
  return result;
}

/**
 * Invoke the most-derived handleEvent(Event) for a component.
 * Returns true if the event was handled (bubbling should stop).
 */
async function invokeHandleEvent(jvm, obj, evt) {
  const method = await jvm.findMethodInHierarchy(obj.type, 'handleEvent', '(Ljava/awt/Event;)Z');
  if (!method || isJreDefault(method)) {
    // JRE default dispatch, mirroring java.awt.Component.handleEvent():
    // route each event id to the legacy typed handler on this component.
    switch (evt ? evt.id : 0) {
      case 401: // ACTION_EVENT
        return invokeAction(jvm, obj, evt, evt.arg);
      case 501: // MOUSE_DOWN
        return invokeTyped(jvm, obj, 'mouseDown', evt, evt.x, evt.y);
      case 502: // MOUSE_UP
        return invokeTyped(jvm, obj, 'mouseUp', evt, evt.x, evt.y);
      case 503: // MOUSE_MOVE
        return invokeTyped(jvm, obj, 'mouseMove', evt, evt.x, evt.y);
      case 506: // MOUSE_DRAG
        return invokeTyped(jvm, obj, 'mouseDrag', evt, evt.x, evt.y);
      default:
        return false;
    }
  }
  return runGuestMethod(jvm, obj.type, method, [obj, evt]);
}

/**
 * Invoke a legacy typed mouse handler (mouseDown/mouseUp/mouseDrag/mouseMove).
 */
async function invokeTyped(jvm, obj, methodName, evt, x, y) {
  const method = await jvm.findMethodInHierarchy(obj.type, methodName, '(Ljava/awt/Event;II)Z');
  if (!method || isJreDefault(method)) return false;
  return runGuestMethod(jvm, obj.type, method, [obj, evt, x, y]);
}

/**
 * Invoke the most-derived action(Event, Object) for a component.
 */
async function invokeAction(jvm, obj, evt, arg) {
  const method = await jvm.findMethodInHierarchy(obj.type, 'action', '(Ljava/awt/Event;Ljava/lang/Object;)Z');
  if (!method || isJreDefault(method)) return false;
  return runGuestMethod(jvm, obj.type, method, [obj, evt, arg]);
}

/**
 * Post a legacy event from a component and bubble it up the hierarchy.
 */
async function postEvent(jvm, source, evt) {
  let current = source;
  while (current) {
    const handled = await invokeHandleEvent(jvm, current, evt);
    if (handled) return true;
    current = current._parent || null;
  }
  return false;
}

/**
 * Build a legacy java.awt.Event and post it from a component.
 * id 401 = ACTION_EVENT (java.awt.Event.ACTION_EVENT).
 */
async function postActionEvent(jvm, source, actionCommand) {
  const evt = {
    type: 'java/awt/Event',
    id: 401,
    target: source,
    arg: actionCommand || null,
    when: Date.now(),
    x: 0,
    y: 0,
    key: 0,
    modifiers: 0,
    clickCount: 0,
    fields: {
      'java/awt/Event.id': 401,
      'java/awt/Event.target': source,
      'java/awt/Event.arg': actionCommand || null,
      'java/awt/Event.when': BigInt(Date.now()),
      'java/awt/Event.x': 0,
      'java/awt/Event.y': 0,
      'java/awt/Event.key': 0,
      'java/awt/Event.modifiers': 0,
      'java/awt/Event.clickCount': 0,
    },
  };
  return postEvent(jvm, source, evt);
}

/**
 * Post a legacy mouse event (MOUSE_DOWN 501, MOUSE_UP 502, MOUSE_MOVE 503,
 * MOUSE_DRAG 506) from a component, with coordinates relative to it.
 */
async function postMouseEvent(jvm, source, id, x, y, modifiers = 0, clickCount = 0) {
  const evt = {
    type: 'java/awt/Event',
    id,
    target: source,
    arg: null,
    when: Date.now(),
    x,
    y,
    key: 0,
    modifiers,
    clickCount,
    fields: {
      'java/awt/Event.id': id,
      'java/awt/Event.target': source,
      'java/awt/Event.arg': null,
      'java/awt/Event.when': BigInt(Date.now()),
      'java/awt/Event.x': x,
      'java/awt/Event.y': y,
      'java/awt/Event.key': 0,
      'java/awt/Event.modifiers': modifiers,
      'java/awt/Event.clickCount': clickCount,
    },
  };
  return postEvent(jvm, source, evt);
}

/**
 * Post a legacy scroll event (SCROLL_ABSOLUTE 606 etc.) from a scrollbar.
 */
async function postScrollEvent(jvm, source, id) {
  const evt = {
    type: 'java/awt/Event',
    id,
    target: source,
    arg: source,
    when: Date.now(),
    x: 0,
    y: 0,
    key: 0,
    modifiers: 0,
    clickCount: 0,
    fields: {
      'java/awt/Event.id': id,
      'java/awt/Event.target': source,
      'java/awt/Event.arg': source,
      'java/awt/Event.when': BigInt(Date.now()),
      'java/awt/Event.x': 0,
      'java/awt/Event.y': 0,
      'java/awt/Event.key': 0,
      'java/awt/Event.modifiers': 0,
      'java/awt/Event.clickCount': 0,
    },
  };
  return postEvent(jvm, source, evt);
}

module.exports = {
  postEvent,
  postActionEvent,
  postMouseEvent,
  postScrollEvent,
  invokeHandleEvent,
  invokeAction,
  invokeTyped,
  runGuestMethod,
};

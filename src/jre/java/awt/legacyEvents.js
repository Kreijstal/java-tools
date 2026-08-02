// Legacy (pre-1.1) AWT event dispatch helpers.
//
// Old applets (e.g. NASA's KiteModeler) never use ActionListener. They
// override handleEvent(Event) / action(Event, Object) on their panels and
// rely on Component.postEvent() bubbling a java.awt.Event up the component
// hierarchy. These helpers execute the guest bytecode overrides and capture
// their boolean result so the bubbling can stop once the event is handled.

const Frame = require('../../../core/frame');
const IntegerClass = require('../lang/Integer');

const ACTION_EVENT = 1001;
const MOUSE_DOWN = 501;
const MOUSE_UP = 502;
const MOUSE_MOVE = 503;
const MOUSE_ENTER = 504;
const MOUSE_EXIT = 505;
const MOUSE_DRAG = 506;
const KEY_PRESS = 401;
const KEY_RELEASE = 402;
const KEY_ACTION = 403;
const KEY_ACTION_RELEASE = 404;

function isJreDefault(method) {
  // Guest methods carry a code attribute; JRE methods are plain JS functions.
  if (!method) return true;
  if (typeof method === 'function' && !method.attributes) return true;
  const code = method.attributes && method.attributes.find(a => a.type === 'code');
  return !code;
}

function yieldToEventLoop() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Push and drain one AWT-owned guest frame without monopolizing the browser.
 * Frames that exceed the cap are removed so they cannot resume later without
 * the bookkeeping that their caller installed.
 */
async function runFrame(jvm, frame, options = {}) {
  const thread = options.thread ||
    jvm.threads[jvm.currentThreadIndex] || jvm.threads[0];
  if (!thread) return { completed: false, iterations: 0, limitReached: false };

  const maxIterations = options.maxIterations || 500000;
  const yieldCheckEvery = options.yieldCheckEvery || 2048;
  const yieldIntervalMs = options.yieldIntervalMs || 16;
  const label = options.label || 'AWT guest frame';
  const depthBefore = thread.callStack.size();
  thread.callStack.push(frame);
  thread.status = 'runnable';
  const targetDepth = thread.callStack.size();
  let iterations = 0;
  let lastYield = Date.now();

  try {
    while (thread.callStack.size() >= targetDepth && iterations < maxIterations &&
        !(options.stopWhen && options.stopWhen())) {
      await jvm.executeTick();
      iterations++;
      if (iterations % yieldCheckEvery === 0 && Date.now() - lastYield >= yieldIntervalMs) {
        await yieldToEventLoop();
        lastYield = Date.now();
      }
    }
  } catch (error) {
    while (thread.callStack.size() > depthBefore) thread.callStack.pop();
    throw error;
  }

  const limitReached = iterations >= maxIterations &&
    thread.callStack.size() >= targetDepth &&
    !(options.stopWhen && options.stopWhen());
  if (limitReached) {
    while (thread.callStack.size() > depthBefore) thread.callStack.pop();
    console.warn(`${label} exceeded iteration limit (${maxIterations})`);
  }
  return {
    completed: thread.callStack.size() < targetDepth ||
      !!(options.stopWhen && options.stopWhen()),
    iterations,
    limitReached,
  };
}

function enqueueLegacyDispatch(jvm, dispatch) {
  const previous = jvm._legacyEventDispatchQueue || Promise.resolve();
  const current = previous.catch(() => undefined).then(dispatch);
  jvm._legacyEventDispatchQueue = current.then(() => undefined, () => undefined);
  return current;
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

  const previousReflectiveState = {
    isAwaitingReflectiveCall: thread.isAwaitingReflectiveCall,
    reflectiveCallFrame: thread.reflectiveCallFrame,
    reflectiveCallResolver: thread.reflectiveCallResolver,
  };
  let result = false;
  let resolved = false;
  try {
    thread.isAwaitingReflectiveCall = true;
    thread.reflectiveCallFrame = frame;
    thread.reflectiveCallResolver = (value) => {
      resolved = true;
      result = !!value;
    };
    await runFrame(jvm, frame, {
      thread,
      stopWhen: () => resolved,
      label: `${className}.${method.name || '<event>'}`,
    });
    return result;
  } finally {
    thread.isAwaitingReflectiveCall = previousReflectiveState.isAwaitingReflectiveCall;
    thread.reflectiveCallFrame = previousReflectiveState.reflectiveCallFrame;
    thread.reflectiveCallResolver = previousReflectiveState.reflectiveCallResolver;
  }
}

/**
 * Invoke the most-derived handleEvent(Event) for a component.
 * Returns true if the event was handled (bubbling should stop).
 */
async function invokeHandleEvent(jvm, obj, evt) {
  const method = await jvm.findMethodInHierarchy(obj.type, 'handleEvent', '(Ljava/awt/Event;)Z');
  if (!method || isJreDefault(method)) {
    return dispatchDefaultEvent(jvm, obj, evt);
  }
  return runGuestMethod(jvm, obj.type, method, [obj, evt]);
}

/** Mirror java.awt.Component.handleEvent's typed legacy dispatch. */
async function dispatchDefaultEvent(jvm, obj, evt) {
  switch (evt ? evt.id : 0) {
    case ACTION_EVENT:
      return invokeAction(jvm, obj, evt, evt.arg);
    case MOUSE_DOWN:
      return invokeTyped(jvm, obj, 'mouseDown', evt, evt.x, evt.y);
    case MOUSE_UP:
      return invokeTyped(jvm, obj, 'mouseUp', evt, evt.x, evt.y);
    case MOUSE_MOVE:
      return invokeTyped(jvm, obj, 'mouseMove', evt, evt.x, evt.y);
    case MOUSE_ENTER:
      return invokeTyped(jvm, obj, 'mouseEnter', evt, evt.x, evt.y);
    case MOUSE_EXIT:
      return invokeTyped(jvm, obj, 'mouseExit', evt, evt.x, evt.y);
    case MOUSE_DRAG:
      return invokeTyped(jvm, obj, 'mouseDrag', evt, evt.x, evt.y);
    case KEY_PRESS:
    case KEY_ACTION:
      return invokeTyped(jvm, obj, 'keyDown', evt, evt.key);
    case KEY_RELEASE:
    case KEY_ACTION_RELEASE:
      return invokeTyped(jvm, obj, 'keyUp', evt, evt.key);
    default:
      return false;
  }
}

/**
 * Invoke a legacy typed mouse handler (mouseDown/mouseUp/mouseDrag/mouseMove).
 */
async function invokeTyped(jvm, obj, methodName, evt, ...values) {
  const descriptor = values.length === 1
    ? '(Ljava/awt/Event;I)Z'
    : '(Ljava/awt/Event;II)Z';
  const method = await jvm.findMethodInHierarchy(obj.type, methodName, descriptor);
  if (!method || isJreDefault(method)) return false;
  return runGuestMethod(jvm, obj.type, method, [obj, evt, ...values]);
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
 * id 1001 = ACTION_EVENT (java.awt.Event.ACTION_EVENT).
 */
async function postActionEvent(jvm, source, actionCommand) {
  const evt = makeEvent({
    id: ACTION_EVENT,
    target: source,
    arg: actionCommand || null,
  });
  return enqueueLegacyDispatch(jvm, () => postEvent(jvm, source, evt));
}

/**
 * Post a legacy mouse event (MOUSE_DOWN 501, MOUSE_UP 502, MOUSE_MOVE 503,
 * MOUSE_DRAG 506) from a component, with coordinates relative to it.
 */
async function postMouseEvent(jvm, source, id, x, y, modifiers = 0, clickCount = 0) {
  const evt = makeEvent({ id, target: source, x, y, modifiers, clickCount });
  return enqueueLegacyDispatch(jvm, () => postEvent(jvm, source, evt));
}

/**
 * Post a legacy scroll event (SCROLL_ABSOLUTE 605 etc.) from a scrollbar.
 */
async function postScrollEvent(jvm, source, id, value) {
  const arg = IntegerClass.staticMethods['valueOf(I)Ljava/lang/Integer;'](
    jvm, null, [value | 0]);
  const evt = makeEvent({ id, target: source, arg });
  return enqueueLegacyDispatch(jvm, () => postEvent(jvm, source, evt));
}

function makeEvent({
  id,
  target,
  arg = null,
  x = 0,
  y = 0,
  key = 0,
  modifiers = 0,
  clickCount = 0,
}) {
  const when = Date.now();
  return {
    type: 'java/awt/Event',
    id,
    target,
    arg,
    when,
    x,
    y,
    key,
    modifiers,
    clickCount,
    fields: {
      'java/awt/Event.id': id,
      'java/awt/Event.target': target,
      'java/awt/Event.arg': arg,
      'java/awt/Event.when': BigInt(when),
      'java/awt/Event.x': x,
      'java/awt/Event.y': y,
      'java/awt/Event.key': key,
      'java/awt/Event.modifiers': modifiers,
      'java/awt/Event.clickCount': clickCount,
    },
  };
}

module.exports = {
  postEvent,
  postActionEvent,
  postMouseEvent,
  postScrollEvent,
  invokeHandleEvent,
  invokeAction,
  invokeTyped,
  dispatchDefaultEvent,
  runGuestMethod,
  runFrame,
  makeEvent,
  isJreDefault,
};

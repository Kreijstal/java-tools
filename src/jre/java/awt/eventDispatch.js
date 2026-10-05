// Event dispatch thread shared by java.awt.EventQueue and javax.swing.
//
// Each invokeLater() callback runs on a guest thread named AWT-EventQueue-0.
// Callbacks run one after another in submission order: a callback's thread
// joins the thread of the callback queued before it. Finished threads are
// reused, so a long-running GUI does not grow jvm.threads per callback.

const Frame = require('../../../core/frame');
const CallStack = require('../../../core/callStack');
const { parseDescriptor } = require('../../../parsing/typeParser');

function runtimeClassName(obj) {
  return obj && (obj._className || obj.type);
}

async function findGuestMethod(jvm, className, name, descriptor) {
  let current = className;
  while (current) {
    let classData = jvm.classes[current];
    if (!classData) classData = await jvm.loadClassByName(current);
    if (!classData) return null;
    const method = jvm.findMethod(classData, name, descriptor);
    if (method) return { method, className: current };
    current = classData.ast?.classes?.[0]?.superClassName || null;
  }
  return null;
}

function assignLocals(frame, start, values, params) {
  let slot = start;
  for (let i = 0; i < values.length; i++) {
    frame.locals[slot] = values[i];
    slot += params[i] === 'long' || params[i] === 'double' ? 2 : 1;
  }
}

function isGuestMethod(method) {
  return !!(method && method.attributes &&
    method.attributes.some((attribute) => attribute.type === 'code'));
}

/**
 * Build a frame that calls target.name(args) — target may be a guest object
 * or a lambda/method reference produced by invokedynamic. Returns null when
 * the callback has no guest body; JRE-native callbacks are run inline.
 */
async function callbackFrame(jvm, target, name, descriptor, args = []) {
  if (!target) return null;
  if (target.methodHandle) {
    const reference = target.methodHandle.reference;
    const targetName = reference.nameAndType.name;
    const targetDescriptor = reference.nameAndType.descriptor;
    const values = [...(target.capturedArgs || []), ...args];
    const isStatic = target.methodHandle.kind === 'invokeStatic';
    const receiver = isStatic ? null : values.shift();
    const owner = target.methodHandle.kind === 'invokeSpecial' || isStatic
      ? reference.className
      : runtimeClassName(receiver) || reference.className;
    const found = await findGuestMethod(jvm, owner, targetName, targetDescriptor);
    if (!found) return null;
    if (!isGuestMethod(found.method)) {
      const native = jvm._jreFindMethod(found.className, targetName, targetDescriptor);
      if (native) await native(jvm, receiver, values);
      return null;
    }
    const frame = new Frame(found.method);
    frame.className = found.className;
    if (!isStatic) frame.locals[0] = receiver;
    assignLocals(frame, isStatic ? 0 : 1, values,
      parseDescriptor(targetDescriptor).params);
    return frame;
  }

  const className = runtimeClassName(target);
  const found = className && await findGuestMethod(jvm, className, name, descriptor);
  if (!found) return null;
  if (!isGuestMethod(found.method)) {
    const native = jvm._jreFindMethod(found.className, name, descriptor);
    if (native) await native(jvm, target, args);
    return null;
  }
  const frame = new Frame(found.method);
  frame.className = found.className;
  frame.locals[0] = target;
  assignLocals(frame, 1, args, parseDescriptor(descriptor).params);
  return frame;
}

function newEventThread(jvm) {
  const ids = (jvm.threads || []).map((thread) => Number(thread.id))
    .filter(Number.isFinite);
  const thread = {
    id: ids.length ? Math.max(...ids) + 1 : 0,
    name: 'AWT-EventQueue-0',
    callStack: new CallStack(),
    status: 'terminated',
    pendingException: null,
    sleepUntil: undefined,
    joiningOn: undefined,
    waitingForClassInitialization: undefined,
    waitingOn: undefined,
    waitDeadline: undefined,
    blockingOn: undefined,
    waitLockCount: undefined,
    isEventDispatchThread: true,
  };
  if (!Array.isArray(jvm.threads)) jvm.threads = [];
  jvm.threads.push(thread);
  return thread;
}

/** Queue a frame behind every callback already submitted; returns its thread. */
function scheduleFrame(jvm, frame) {
  const pool = jvm._eventDispatchThreads || (jvm._eventDispatchThreads = []);
  const tail = jvm._eventDispatchTail;
  let thread = pool.find((candidate) =>
    candidate !== tail &&
    candidate.status === 'terminated' &&
    candidate.callStack.isEmpty() &&
    !(jvm.threads || []).some((other) => other.joiningOn === candidate));
  if (!thread) {
    thread = newEventThread(jvm);
    pool.push(thread);
  }
  thread.callStack.push(frame);
  if (tail && tail.status !== 'terminated') {
    thread.status = 'JOINING';
    thread.joiningOn = tail;
  } else {
    thread.status = 'runnable';
  }
  jvm._eventDispatchTail = thread;
  return thread;
}

async function invokeLater(jvm, target, name, descriptor, args = []) {
  const frame = await callbackFrame(jvm, target, name, descriptor, args);
  return frame ? scheduleFrame(jvm, frame) : null;
}

/** Run a Runnable on the dispatch thread and block the calling guest thread. */
async function invokeAndWait(jvm, runnable, callingThread) {
  const dispatchThread = await invokeLater(jvm, runnable, 'run', '()V');
  if (!dispatchThread || !callingThread || callingThread === dispatchThread) return;
  callingThread.status = 'JOINING';
  callingThread.joiningOn = dispatchThread;
}

function isDispatchThread(jvm, thread) {
  const current = thread || jvm.threads[jvm.currentThreadIndex];
  return !!(current && (current.isEventDispatchThread || current === jvm._awtEventThread));
}

module.exports = {
  callbackFrame,
  scheduleFrame,
  invokeLater,
  invokeAndWait,
  isDispatchThread,
};

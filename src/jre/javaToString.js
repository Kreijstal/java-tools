'use strict';
// String conversion of a Java reference for JRE natives (String.valueOf,
// print/println, StringBuilder.append): Java calls the object's toString(),
// which may be a guest override. Objects whose toString() is the JRE's own
// convert synchronously. For a guest override the native pushes the
// toString() frame and returns ASYNC_METHOD_SENTINEL, as Method.invoke does;
// the frame's return finishes the native.
const Frame = require('../core/frame');
const { ASYNC_METHOD_SENTINEL } = require('../core/constants');

const TO_STRING = 'toString';
const TO_STRING_DESCRIPTOR = '()Ljava/lang/String;';

function hasCode(method) {
  return !!(method && method.attributes && method.attributes.some((a) => a.type === 'code'));
}

// The guest toString() a class inherits, or null when it is the JRE's.
// Instances only exist for loaded classes, so the walk never loads one.
function guestToString(jvm, type) {
  const cache = jvm._guestToStringCache || (jvm._guestToStringCache = new Map());
  if (cache.has(type)) return cache.get(type);
  let found = null;
  for (let name = type; name;) {
    const classData = jvm.classes && jvm.classes[name];
    const cls = classData && classData.ast && classData.ast.classes && classData.ast.classes[0];
    if (!cls) break;
    const method = jvm.findMethod(classData, TO_STRING, TO_STRING_DESCRIPTOR);
    if (method) {
      if (hasCode(method)) found = { className: name, method };
      break;
    }
    name = cls.superClassName;
  }
  cache.set(type, found);
  return found;
}

// Converts `value` and passes the string to `then(string, callingFrame)`.
// Returns then's result when the conversion is synchronous; otherwise pushes
// the guest toString() frame and returns ASYNC_METHOD_SENTINEL, and `then`
// runs when that frame returns: whatever the native's caller receives, then
// pushes onto `callingFrame`'s operand stack itself.
function withJavaString(jvm, value, fallback, thread, then) {
  const target = value !== null && typeof value === 'object' && typeof value.type === 'string' &&
    value.type[0] !== '[' ? guestToString(jvm, value.type) : null;
  if (!target) return then(value === null || value === undefined ? 'null' : fallback(value), null);
  const t = thread || jvm.threads[jvm.currentThreadIndex] || jvm.threads[0];
  const callingFrame = t.callStack.peek();
  const frame = new Frame(target.method);
  frame.className = target.className;
  frame.locals[0] = value;
  // A toString() that converts another object nests: restore the outer
  // pending call when this one returns.
  const previous = {
    isAwaitingReflectiveCall: t.isAwaitingReflectiveCall,
    reflectiveCallFrame: t.reflectiveCallFrame,
    reflectiveCallResolver: t.reflectiveCallResolver,
  };
  t.isAwaitingReflectiveCall = true;
  t.reflectiveCallFrame = frame;
  t.reflectiveCallResolver = (returned) => {
    Object.assign(t, previous);
    then(returned === null || returned === undefined ? 'null' : fallback(returned), callingFrame);
  };
  t.callStack.push(frame);
  return ASYNC_METHOD_SENTINEL;
}

// Marks a native that may push a guest frame, so no JIT calls it directly.
function pushesFrames(native) {
  native.jvmPushesFrames = true;
  return native;
}

module.exports = { withJavaString, pushesFrames };

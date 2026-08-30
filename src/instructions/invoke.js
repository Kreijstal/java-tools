const { parseDescriptor } = require("../parsing/typeParser");
const Frame = require("../core/frame");
const Stack = require("../core/stack");
const path = require("path");
const { MethodHandle, MethodType, Lookup } = require("../jre/java/lang/invoke");
const { ASYNC_METHOD_SENTINEL } = require("../core/constants");
const {
  classInitializationTokenFor,
} = require('./utils');

const resolvedSyncInvokeSite = Symbol('resolvedSyncInvokeSite');
const SYNC_INVOKE_FALLBACK = Symbol('syncInvokeFallback');
const frameHandoffTracePattern = typeof process !== 'undefined' && process.env
  ? process.env.JVM_TRACE_FRAME_HANDOFF || '' : '';
const frameHandoffTracePc = typeof process !== 'undefined' && process.env &&
  process.env.JVM_TRACE_FRAME_HANDOFF_PC !== undefined
  ? Number(process.env.JVM_TRACE_FRAME_HANDOFF_PC) : null;
// Parsed once. This was read, string-coerced and split on EVERY constructor
// dispatch — two allocations per `new` on the interpreter's hottest path, paid
// in full by every run that never sets the variable.
const debugConstructorOwners = new Set(
  ((typeof process !== 'undefined' && process.env
    ? process.env.JVM_DEBUG_CONSTRUCTORS : '') || '').split(',').filter(Boolean));

function runtimeClassName(obj) {
  return obj && (obj._className || obj.type);
}

function assignArgsToLocals(locals, args, params, startIndex) {
  let localIndex = startIndex;
  for (let i = 0; i < params.length; i++) {
    locals[localIndex] = args[i];
    if (params[i] === "long" || params[i] === "double") {
      localIndex += 2;
    } else {
      localIndex += 1;
    }
  }
}

function syncSiteState(instruction, descriptor) {
  let state = instruction && instruction[resolvedSyncInvokeSite];
  if (state) return state;
  const parsed = parseDescriptor(descriptor);
  state = {
    params: parsed.params,
    returnType: parsed.returnType,
    epoch: -1,
    fusedCandidate: undefined,
    staticTarget: undefined,
    receiverClass0: null,
    target0: undefined,
    receiverClass1: null,
    target1: undefined,
  };
  if (instruction && typeof instruction === 'object') {
    try {
      Object.defineProperty(instruction, resolvedSyncInvokeSite, {
        configurable: true, writable: true, value: state,
      });
    } catch (_) {
      // Frozen diagnostic fixtures retain a per-execution temporary state.
    }
  }
  return state;
}

function resolveLoadedBytecodeTarget(jvm, startClassName, methodName, descriptor,
  kind, receiverClassName) {
  let currentClassName = receiverClassName || startClassName;
  while (currentClassName) {
    // Resolve already-registered targeted overrides and platform methods once;
    // their returned Promise/blocking behavior is still honored by the caller.
    const mayResolveNative = kind === 'static' ||
      (kind === 'special' ? currentClassName === startClassName && jvm.jre[currentClassName]
        : jvm.jre[currentClassName]);
    const native = mayResolveNative
      ? jvm._jreFindMethod(currentClassName, methodName, descriptor)
      : null;
    if (native) return { native, owner: currentClassName };
    const classData = jvm.classes[currentClassName];
    const knownJre = Boolean(jvm.jre[currentClassName]);
    if (!classData || (classData.isJreStub && !knownJre)) return null;
    const method = jvm.findMethod(classData, methodName, descriptor);
    if (method) {
      const isStatic = Boolean(method.flags && method.flags.includes('static'));
      if ((kind === 'static') !== isStatic) return null;
      return { method, owner: currentClassName };
    }
    if (kind === 'special' && methodName === '<init>') return null;
    currentClassName = classData.ast && classData.ast.classes[0]
      ? classData.ast.classes[0].superClassName
      : null;
  }
  return null;
}

function pushBytecodeInvokeFrame(frame, thread, target, params, receiver, isStatic) {
  const args = new Array(params.length);
  for (let i = params.length - 1; i >= 0; i -= 1) args[i] = frame.stack.pop();
  if (!isStatic) frame.stack.pop();
  const child = new Frame(target.method);
  child.className = target.owner;
  let start = 0;
  if (!isStatic) {
    child.locals[0] = receiver;
    start = 1;
  }
  assignArgsToLocals(child.locals, args, params, start);
  if (frameHandoffTracePattern) {
    const parentIdentity = `${frame.className || '?'}.${frame.method?.name || '?'}${
      frame.method?.descriptor || ''}`;
    if (parentIdentity.includes(frameHandoffTracePattern) &&
        (!Number.isInteger(frameHandoffTracePc) || frame.pc === frameHandoffTracePc)) {
      child.jitFrameHandoffTrace = {
        parent: parentIdentity,
        parentPc: frame.pc,
        child: `${child.className || '?'}.${child.method?.name || '?'}${
          child.method?.descriptor || ''}`,
      };
      console.error('[jvm-frame-handoff-push] ' + JSON.stringify(
        child.jitFrameHandoffTrace));
    }
  }
  thread.callStack.push(child);
  if (debugConstructorOwners.size && target.method &&
      target.method.name === '<init>' && debugConstructorOwners.has(target.owner)) {
    console.error(`[constructor] sync push ${target.owner}${target.method.descriptor} from ` +
      `${frame.className}.${frame.method && frame.method.name}` +
      `${frame.method && frame.method.descriptor || ''}@${frame.pc - 1}`);
  }
}

function invokeNativeSync(frame, thread, target, state, receiver, kind, jvm) {
  const args = new Array(state.params.length);
  for (let i = state.params.length - 1; i >= 0; i -= 1) args[i] = frame.stack.pop();
  if (kind !== 'static') frame.stack.pop();
  const finish = (result) => {
    if (kind === 'virtual' && thread.status === 'BLOCKED') {
      frame.stack.push(receiver);
      for (const arg of args) frame.stack.push(arg);
      return undefined;
    }
    const isVoid = state.returnType === 'V' || state.returnType === 'void';
    const suppressSentinel = kind !== 'static' && result === ASYNC_METHOD_SENTINEL;
    if (!isVoid && !suppressSentinel && result !== undefined) {
      frame.stack.push(typeof result === 'boolean' ? (result ? 1 : 0) : result);
    }
    return undefined;
  };
  const result = target.native(jvm,
    kind === 'static' ? null : receiver, args, thread);
  return result && typeof result.then === 'function' ? result.then(finish) : finish(result);
}

function invokeBytecodeSync(frame, instruction, jvm, thread, kind) {
  const [_, className, [methodName, descriptor]] = instruction.arg;
  const state = syncSiteState(instruction, descriptor);
  if (state.epoch !== jvm.classEpoch) {
    state.epoch = jvm.classEpoch;
    state.fusedCandidate = undefined;
    state.staticTarget = undefined;
    state.receiverClass0 = null;
    state.target0 = undefined;
    state.receiverClass1 = null;
    state.target1 = undefined;
  }
  if (kind === 'static') {
    const init =
      classInitializationTokenFor(jvm, instruction, className).state;
    if (init !== 'INITIALIZED' &&
        !(init === 'INITIALIZING' &&
          jvm.classInitializationOwners.get(className) === thread.id)) {
      return SYNC_INVOKE_FALLBACK;
    }
    let target = state.staticTarget;
    if (target === undefined) {
      target = resolveLoadedBytecodeTarget(
        jvm, className, methodName, descriptor, kind, null,
      ) || null;
      state.staticTarget = target;
    }
    if (!target) return SYNC_INVOKE_FALLBACK;
    if (target.native) {
      return invokeNativeSync(frame, thread, target, state, null, kind, jvm);
    }
    const fusedRegions = jvm.jit && jvm.jit.fusedRegions;
    if (fusedRegions && fusedRegions.enabled) {
      if (state.fusedCandidate === undefined) {
        state.fusedCandidate = fusedRegions.mayFuse(target.method);
      }
      if (state.fusedCandidate) {
        const fused = fusedRegions.tryInvoke({
          op: 'invokestatic',
          descriptor,
          params: state.params,
          returnType: state.returnType,
        }, {
          method: target.method,
          lookupClass: target.owner,
        }, frame, thread);
        if (fused.handled) return undefined;
      }
    }
    pushBytecodeInvokeFrame(frame, thread, target, state.params, null, true);
    return undefined;
  }

  const receiverIndex = frame.stack.items.length - state.params.length - 1;
  const receiver = frame.stack.items[receiverIndex];
  if (receiver === null || receiver === undefined ||
      typeof receiver === 'number' || typeof receiver === 'boolean' ||
      receiver._annotationData || receiver.methodHandle) return SYNC_INVOKE_FALLBACK;
  let receiverClassName = kind === 'special' ? className : runtimeClassName(receiver);
  if (typeof receiverClassName !== 'string' || receiverClassName.startsWith('[')) {
    return SYNC_INVOKE_FALLBACK;
  }
  let target;
  if (state.receiverClass0 === receiverClassName) target = state.target0;
  else if (state.receiverClass1 === receiverClassName) target = state.target1;
  if (target === undefined) {
    target = resolveLoadedBytecodeTarget(
      jvm, className, methodName, descriptor, kind, receiverClassName,
    ) || null;
    state.receiverClass1 = state.receiverClass0;
    state.target1 = state.target0;
    state.receiverClass0 = receiverClassName;
    state.target0 = target;
  }
  if (!target) return SYNC_INVOKE_FALLBACK;
  if (target.native) {
    return invokeNativeSync(frame, thread, target, state, receiver, kind, jvm);
  }
  if (jvm.jit && jvm.jit.tryInvokeInterpreterReferenceFieldHelper(
    frame, thread, kind, target, state)) {
    return undefined;
  }
  pushBytecodeInvokeFrame(frame, thread, target, state.params, receiver, false);
  return undefined;
}

// Helper function to format numbers according to Java's rules
function formatJavaNumber(value, type) {
  if (type === "boolean" || type === "Z") {
    return value === 1 ? "true" : "false";
  }
  if (type === 'double' || type === 'D') {
    // Re-use the logic from Double.toString() for consistency.
    if (isNaN(value)) return "NaN";
    if (value === Number.POSITIVE_INFINITY) return "Infinity";
    if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
    if (value === 0.0) return '0.0';
    if (value === -0.0) return '-0.0';


    const absD = Math.abs(value);
    let s;
    if (absD >= 1e-3 && absD < 1e7) {
      s = String(value);
      if (!s.includes('.') && !s.includes('e')) {
          s += '.0';
      }
    } else {
      s = value.toExponential().replace('e+', 'E').replace('e', 'E');
    }
    return s;
  }
  if (type === 'float' || type === 'F') {
    if (Number.isInteger(value)) {
      return value + ".0";
    }
    // For float, use 7 decimal places like Java typically does
    return value.toFixed(7).replace(/\.?0+$/, "");
  }
  if (type === 'char' || type === 'C') {
    return String.fromCharCode(value);
  }
  if (type === 'int' || type === 'I' || type === 'short' || type === 'S' || type === 'byte' || type === 'B') {
    return String(value);
  }

  return String(value);
}

// Helper function to auto-box primitives when needed
function autoboxPrimitive(jvm, value) {
  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      // Integer autoboxing
      return {
        type: "java/lang/Integer",
        value: value,
        toString: function () {
          return this.value.toString();
        },
      };
    } else {
      // Double autoboxing
      return {
        type: "java/lang/Double",
        value: value,
        toString: function () {
          return this.value.toString();
        },
      };
    }
  }
  if (typeof value === "boolean") {
    // Boolean autoboxing
    return {
      type: "java/lang/Boolean",
      value: value, // Store the boolean value directly
      booleanValue: value, // Store original boolean value
      toString: function () {
        return value ? "true" : "false";
      },
    };
  }
  if (typeof value === "string") {
    // String is already an object in our JVM implementation
    return value;
  }
  return value;
}

async function invokevirtual(frame, instruction, jvm, thread) {
  const [_, className, [methodName, descriptor]] = instruction.arg;
  const { params } = parseDescriptor(descriptor);
  const args = [];
  for (let i = 0; i < params.length; i++) {
    args.unshift(frame.stack.pop());
  }
  const obj = frame.stack.pop();

  if (obj === undefined) {
    throw {
      type: "java/lang/NullPointerException",
      message: "Stack is empty when calling virtual method",
    };
  }

  // Auto-box primitive if needed (when a primitive is being used as an object)
  let boxedObj = obj;
  if (typeof obj === "number" || typeof obj === "boolean") {
    boxedObj = autoboxPrimitive(jvm, obj);
  }

  // Check for null object reference
  if (boxedObj === null) {
    throw {
      type: "java/lang/NullPointerException",
      message: null,
      context: {
        frame: frame,
        pc: frame.instructions[frame.pc - 1].pc,
        className: className,
        methodName: methodName,
      },
    };
  }

  let currentClassName = runtimeClassName(boxedObj);
  if (typeof currentClassName !== 'string') currentClassName = className;

  if (boxedObj._annotationData) {
    const methodKey = methodName + descriptor;
    if (typeof boxedObj[methodKey] === "function") {
      const result = boxedObj[methodKey]();
      const { returnType } = parseDescriptor(descriptor);
      if (returnType !== "V" && returnType !== "void" && result !== undefined) {
        frame.stack.push(result);
      }
      return;
    }
  }

  // Handle arrays - they inherit from Object
  if (currentClassName && currentClassName.startsWith("[")) {
    const jreMethod = jvm._jreFindMethod(
      "java/lang/Object",
      methodName,
      descriptor,
    );
    if (jreMethod) {
      let result = jreMethod(jvm, boxedObj, args, thread);
      if (result && typeof result.then === "function") {
        result = await result;
      }
      if (result !== ASYNC_METHOD_SENTINEL) {
        const { returnType } = parseDescriptor(descriptor);
        if (returnType !== "V" && returnType !== "void" && result !== undefined) {
          if (typeof result === "boolean") {
            result = result ? 1 : 0;
          }
          frame.stack.push(result);
        }
      }
      return;
    }
  }

  while (currentClassName) {
    let jreMethod = null;
    if (jvm.jre[currentClassName]) {
      jreMethod = jvm._jreFindMethod(currentClassName, methodName, descriptor);
    }
    if (jreMethod) {
      let result = jreMethod(jvm, boxedObj, args, thread);

      // Check if the result is a Promise and await it
      if (result && typeof result.then === "function") {
        result = await result;
      }

      if (thread.status === "BLOCKED") {
        // If the thread was blocked (e.g. by a lock), push the arguments back on the stack
        // so they are available when the instruction is re-executed.
        frame.stack.push(obj);
        for (const arg of args) {
          frame.stack.push(arg);
        }
        return;
      }
      if (result !== ASYNC_METHOD_SENTINEL) {
        const { returnType } = parseDescriptor(descriptor);
        if (returnType !== "V" && returnType !== "void" && result !== undefined) {
          if (typeof result === "boolean") {
            result = result ? 1 : 0;
          }
          frame.stack.push(result);
        }
      }
      return;
    }


    let classData = jvm.classes[currentClassName];
    const isKnownJreClass = !!jvm.jre[currentClassName];
    if (classData && classData.isJreStub && !isKnownJreClass) {
      const loadedClassData = await jvm.loadClassByName(currentClassName);
      if (loadedClassData && !loadedClassData.isJreStub) {
        classData = loadedClassData;
      }
    }
    if (!classData) {
      if (isKnownJreClass) {
        break; // Platform JRE shims are runtime-only.
      }
      classData = await jvm.loadClassByName(currentClassName);
      if (!classData && jvm.jre[currentClassName]) {
        break;
      }
    }

    if (classData) {
      const method = jvm.findMethod(classData, methodName, descriptor);
      if (method) {
        // Validate that the method is not static for invokevirtual
        if (method.flags && method.flags.includes("static")) {
          throw new Error(
            `IncompatibleClassChangeError: invokevirtual called on static method ${currentClassName}.${methodName}${descriptor}`
          );
        }

        const newFrame = new Frame(method);
        newFrame.className = currentClassName; // Add className to the frame
        newFrame.locals[0] = obj; // 'this'
        assignArgsToLocals(newFrame.locals, args, params, 1);
        thread.callStack.push(newFrame);
        return;
      }
      currentClassName = classData.ast.classes[0].superClassName;
    } else {
      currentClassName = null;
    }
  }

  // A raw number in a reference receiver slot is autoboxed above, so the
  // unmodified message names java/lang/Integer and sends the reader hunting a
  // boxing bug that does not exist. Report the condition that actually holds.
  const receiverName = typeof obj === "number"
    ? `int(${obj})`
    : runtimeClassName(boxedObj) || typeof boxedObj;
  throw new Error(
    `Unsupported invokevirtual: ${receiverName}.${methodName}${descriptor} ` +
    `(declared ${className}, caller ${frame.className}.${frame.method && frame.method.name}${frame.method && frame.method.descriptor}, pc ${frame.pc - 1})`,
  );
}

async function invokestatic(frame, instruction, jvm, thread) {
  const [_, className, [methodName, descriptor]] = instruction.arg;

  const wasFramePushed = await jvm.initializeClassIfNeeded(className, thread);
  if (wasFramePushed) {
    frame.pc--;
    return;
  }

  // First, check for JRE/JNI methods. This handles both JRE static methods
  // and native methods on user classes.
  const jreMethod = jvm._jreFindMethod(className, methodName, descriptor);
  if (jreMethod) {
    const { params } = parseDescriptor(descriptor);
    const args = [];
    for (let i = 0; i < params.length; i++) {
      args.unshift(frame.stack.pop());
    }

    let result = await jreMethod(jvm, null, args, thread);
    const { returnType } = parseDescriptor(descriptor);
    if (returnType !== "V" && returnType !== "void" && result !== undefined) {
      if (typeof result === "boolean") {
        result = result ? 1 : 0;
      }
      frame.stack.push(result);
    }
    return;
  }

  // A caller may register a targeted override for an application class. In
  // that case an unoverridden method must still resolve from the loaded class;
  // treating the whole class as a platform stub leaves its arguments on the
  // operand stack and corrupts the next instruction.
  if (jvm.jre[className] && !jvm.jre[className].applicationFallback) {
    throw {
      type: 'java/lang/NoSuchMethodError',
      message: `${className}.${methodName}${descriptor}`,
    };
  }

  // Otherwise, it must be a user-defined class.
  let workspaceEntry = jvm.classes[className];
  if (!workspaceEntry) {
    workspaceEntry = await jvm.loadClassByName(className);
  }

  let resolvedClassName = className;
  let resolvedClassData = workspaceEntry;
  let method = null;

  while (resolvedClassData) {
    method = jvm.findMethod(resolvedClassData, methodName, descriptor);
    if (method) {
      resolvedClassName = resolvedClassData.ast.classes[0].className;
      break;
    }

    const superClassName = resolvedClassData.ast.classes[0].superClassName;
    if (!superClassName) {
      break;
    }

    resolvedClassData = jvm.classes[superClassName] || await jvm.loadClassByName(superClassName);
  }

  if (method) {
    // Validate that the method is actually static for invokestatic
    if (!method.flags || !method.flags.includes("static")) {
      throw new Error(
        `IncompatibleClassChangeError: invokestatic called on non-static method ${resolvedClassName}.${methodName}${descriptor}`
      );
    }

    if (method.flags && method.flags.includes("native")) {
      // This case should be handled by the _jreFindMethod call above,
      // but as a fallback, we can do nothing.
    } else {
      // We found a bytecode method.
      const newFrame = new Frame(method);
      newFrame.className = resolvedClassName; // Add className to the frame
      const { params } = parseDescriptor(descriptor);
      const args = [];
      for (let i = 0; i < params.length; i++) {
        args.unshift(frame.stack.pop());
      }
      assignArgsToLocals(newFrame.locals, args, params, 0);
      thread.callStack.push(newFrame);
    }
  } else if (!resolvedClassData) {
    throw {
      type: 'java/lang/NoClassDefFoundError',
      message: className,
    };
  } else {
    throw {
      type: 'java/lang/NoSuchMethodError',
      message: `${className}.${methodName}${descriptor}`,
    };
  }
}

async function invokespecial(frame, instruction, jvm, thread) {
  const [_, className, [methodName, descriptor]] = instruction.arg;
  const debugConstructor = debugConstructorOwners.size &&
    methodName === '<init>' && debugConstructorOwners.has(className);
  if (debugConstructor) {
    console.error(`[constructor] dispatch ${className}${descriptor} from ` +
      `${frame.className}.${frame.method && frame.method.name}@${frame.pc - 1}`);
  }
  const { params } = parseDescriptor(descriptor);
  const args = [];
  for (let i = 0; i < params.length; i++) {
    args.unshift(frame.stack.pop());
  }
  const obj = frame.stack.pop();
  if (debugConstructor) {
    const describe = (value) => value === null ? "null"
      : value === undefined ? "undefined"
        : runtimeClassName(value) || typeof value;
    console.error(`[constructor] operands receiver=${describe(obj)} ` +
      `args=${args.map(describe).join(",")}`);
  }

  let jreMethod = null;
  if (jvm.jre[className]) {
    jreMethod = jvm._jreFindMethod(className, methodName, descriptor);
  }

  if (jreMethod) {
    let result = await jreMethod(jvm, obj, args, thread);
    if (result !== ASYNC_METHOD_SENTINEL) {
      const { returnType } = parseDescriptor(descriptor);
      if (returnType !== "V" && returnType !== "void" && result !== undefined) {
        if (typeof result === "boolean") {
          result = result ? 1 : 0;
        }
        frame.stack.push(result);
      }
    }
    return;
  }

  // For user-defined methods (constructors, private methods, super calls)
  let workspaceEntry = jvm.classes[className];
  const isKnownJreClass = !!jvm.jre[className];
  if (workspaceEntry && workspaceEntry.isJreStub && !isKnownJreClass) {
    const loadedClassData = await jvm.loadClassByName(className);
    if (loadedClassData && !loadedClassData.isJreStub) {
      workspaceEntry = loadedClassData;
    }
  }
  if (!workspaceEntry) {
    if (isKnownJreClass) {
      return;
    }
    // If class is not loaded, loading it.
    workspaceEntry = await jvm.loadClassByName(className);
    if (!workspaceEntry) {
      if (jvm.jre[className]) {
        return;
      }
      console.error(`Class not found for invokespecial: ${className}`);
      return;
    }
  }

  let resolvedClassName = className;
  let resolvedClassData = workspaceEntry;
  let method = null;

  while (resolvedClassData) {
    method = jvm.findMethod(resolvedClassData, methodName, descriptor);
    if (method) {
      resolvedClassName = resolvedClassData.ast.classes[0].className;
      break;
    }

    if (methodName === "<init>") {
      break;
    }

    const superClassName = resolvedClassData.ast.classes[0].superClassName;
    if (!superClassName) {
      break;
    }
    const isKnownJreSuperClass = !!jvm.jre[superClassName];
    if (isKnownJreSuperClass) {
      break;
    }
    resolvedClassData = jvm.classes[superClassName];
    if (resolvedClassData && resolvedClassData.isJreStub && !isKnownJreSuperClass) {
      const loadedClassData = await jvm.loadClassByName(superClassName);
      if (loadedClassData && !loadedClassData.isJreStub) {
        resolvedClassData = loadedClassData;
      }
    }
    if (!resolvedClassData) {
      resolvedClassData = await jvm.loadClassByName(superClassName);
    }
    if (!resolvedClassData && jvm.jre[superClassName]) {
      break;
    }
  }

  if (method) {
    const newFrame = new Frame(method);
    newFrame.className = resolvedClassName; // Add className to the frame
    newFrame.locals[0] = obj; // 'this'
    assignArgsToLocals(newFrame.locals, args, params, 1);
    thread.callStack.push(newFrame);
    if (debugConstructor) {
      console.error(`[constructor] async push ${resolvedClassName}${descriptor}`);
    }
  } else {
    throw new Error(
      `Unsupported invokespecial: ${className}.${methodName}${descriptor}`,
    );
  }
}

function internalNameFromJavaType(type) {
  if (typeof type !== "string") return type;
  return type.replace(/\./g, "/");
}

function bootstrapReference(bsm) {
  return bsm && bsm.method_ref && bsm.method_ref.value
    ? bsm.method_ref.value.reference
    : null;
}

function popArguments(frame, descriptor) {
  const { params } = parseDescriptor(descriptor);
  const args = new Array(params.length);
  for (let i = params.length - 1; i >= 0; i -= 1) {
    args[i] = frame.stack.pop();
  }
  return { args, params };
}

function stringifyConcatValue(value, type) {
  if (value === null || value === undefined) return "null";
  if (value && typeof value === "object" && value.value !== undefined) {
    return String(value.value);
  }
  if (value && typeof value === "object" && value.toString) {
    return value.toString();
  }
  return formatJavaNumber(value, type);
}

function resolveInvokeDynamicSite(className, frame, instruction, jvm) {
  const invokeDynamicInfo = instruction.arg || {};
  const nameAndType = invokeDynamicInfo.nameAndType || {};
  const classData = jvm.classes[className];
  const bootstrapMethods = classData && classData.ast &&
    classData.ast.classes[0].bootstrapMethods;
  const bsm = bootstrapMethods &&
    bootstrapMethods[invokeDynamicInfo.bootstrap_method_attr_index];
  const reference = bootstrapReference(bsm);
  if (!reference) {
    throw new Error(
      `BootstrapMethodError: missing bootstrap method for ${className}.` +
      `${frame.method.name}${frame.method.descriptor}`,
    );
  }

  const bootstrapClass = reference.className;
  if (bootstrapClass === "java/lang/invoke/StringConcatFactory") {
    const staticArguments = bsm.arguments || [];
    return {
      kind: "stringConcat",
      descriptor: nameAndType.descriptor,
      recipe: staticArguments[0] ? staticArguments[0].value : "\u0001",
      constants: staticArguments.slice(1).map((argument) => argument.value),
    };
  }

  if (bootstrapClass === "java/lang/invoke/LambdaMetafactory") {
    const staticArguments = bsm.arguments || [];
    const implementation = staticArguments.find(
      (argument) => argument && argument.type === "MethodHandle",
    );
    if (!implementation || !implementation.value) {
      throw new Error(
        `BootstrapMethodError: LambdaMetafactory site ${nameAndType.name}` +
        `${nameAndType.descriptor} has no implementation handle`,
      );
    }
    const invokedType = parseDescriptor(nameAndType.descriptor);
    return {
      kind: "lambda",
      descriptor: nameAndType.descriptor,
      interfaceClass: internalNameFromJavaType(invokedType.returnType),
      interfaceMethodName: nameAndType.name,
      methodHandle: new MethodHandle(
        implementation.value.kind,
        implementation.value.reference,
      ),
    };
  }

  throw new Error(
    `Unsupported invokedynamic bootstrap: ${bootstrapClass}.` +
    `${reference.nameAndType.name}${reference.nameAndType.descriptor}`,
  );
}

function executeInvokeDynamicSite(site, frame, jvm) {
  if (site.kind === "lambda") {
    const { args: capturedArgs } = popArguments(frame, site.descriptor);
    frame.stack.push({
      type: site.interfaceClass,
      methodHandle: site.methodHandle,
      capturedArgs,
      functionalMethodName: site.interfaceMethodName,
    });
    return;
  }

  if (site.kind === "stringConcat") {
    const { args: dynamicArgs, params } = popArguments(frame, site.descriptor);
    let result = "";
    let dynamicIndex = 0;
    let constantIndex = 0;
    for (const character of String(site.recipe)) {
      if (character === "\u0001") {
        result += stringifyConcatValue(
          dynamicArgs[dynamicIndex],
          params[dynamicIndex],
        );
        dynamicIndex += 1;
      } else if (character === "\u0002") {
        result += stringifyConcatValue(site.constants[constantIndex], null);
        constantIndex += 1;
      } else {
        result += character;
      }
    }
    frame.stack.push(jvm.newString(result));
  }
}

async function invokedynamic(frame, instruction, jvm, thread) {
  const className = jvm.findClassNameForMethod(frame.method);
  const pc = frame.pc - 1;
  const cacheKey =
    `${className}.${frame.method.name}${frame.method.descriptor}@${pc}`;
  let site = jvm.invokedynamicCache.get(cacheKey);
  if (!site) {
    site = resolveInvokeDynamicSite(className, frame, instruction, jvm);
    jvm.invokedynamicCache.set(cacheKey, site);
  }
  executeInvokeDynamicSite(site, frame, jvm);
}

async function resolveDefaultInterfaceMethod(
  jvm,
  interfaceNames,
  methodName,
  descriptor,
  visited = new Set(),
) {
  for (const interfaceName of interfaceNames || []) {
    if (visited.has(interfaceName)) continue;
    visited.add(interfaceName);
    const classData = jvm.classes[interfaceName] ||
      await jvm.loadClassByName(interfaceName);
    if (!classData || !classData.ast || !classData.ast.classes[0]) continue;
    const method = jvm.findMethod(classData, methodName, descriptor);
    if (method && (!method.flags || !method.flags.includes('abstract'))) {
      return { className: interfaceName, method };
    }
    const inherited = await resolveDefaultInterfaceMethod(
      jvm,
      classData.ast.classes[0].interfaces,
      methodName,
      descriptor,
      visited,
    );
    if (inherited) return inherited;
  }
  return null;
}

async function invokeinterface(frame, instruction, jvm, thread) {
  const [_, className, [methodName, descriptor]] = instruction.arg;
  const { params } = parseDescriptor(descriptor);
  const args = [];
  for (let i = 0; i < params.length; i++) {
    args.unshift(frame.stack.pop());
  }
  const obj = frame.stack.pop();

  // Auto-box primitive if needed
  let boxedObj = obj;
  if (typeof obj === "number" || typeof obj === "boolean") {
    boxedObj = autoboxPrimitive(jvm, obj);
  }

  // Check for null object reference
  if (boxedObj === null) {
    throw {
      type: "java/lang/NullPointerException",
      message: "Attempted to invoke interface method on null object reference",
    };
  }

  // For a functional interface with method handle (lambdas)
  if (boxedObj.methodHandle) {
    const targetMethodHandle = boxedObj.methodHandle;
    const targetReference = targetMethodHandle.reference;
    const targetNameAndType = targetReference.nameAndType;
    const invocationArgs = [...(boxedObj.capturedArgs || []), ...args];
    for (const arg of invocationArgs) {
      frame.stack.push(arg);
    }
    const lambdaInstruction = {
      op: targetMethodHandle.kind,
      arg: [
        "Method",
        targetReference.className,
        [
          targetNameAndType.name,
          targetNameAndType.descriptor,
        ],
      ],
    };
    if (targetMethodHandle.kind === "invokeStatic") {
      await invokestatic(frame, lambdaInstruction, jvm, thread);
    } else if (targetMethodHandle.kind === "invokeVirtual") {
      await invokevirtual(frame, lambdaInstruction, jvm, thread);
    } else if (targetMethodHandle.kind === "invokeInterface") {
      await invokeinterface(frame, lambdaInstruction, jvm, thread);
    } else if (targetMethodHandle.kind === "invokeSpecial") {
      await invokespecial(frame, lambdaInstruction, jvm, thread);
    } else {
      throw new Error(
        `Unsupported lambda MethodHandle kind: ${targetMethodHandle.kind}`,
      );
    }
    return;
  }

  // For regular interface implementations, treat like invokevirtual
  const receiverClassName = runtimeClassName(boxedObj);
  const jreClass = jvm.jre[receiverClassName];
  if (
    jreClass &&
    jreClass.methods &&
    jreClass.methods[methodName + descriptor]
  ) {
    let result = jreClass.methods[methodName + descriptor](
      jvm,
      boxedObj,
      args,
      thread,
    );
    if (result && typeof result.then === "function") {
      result = await result;
    }
    const { returnType } = parseDescriptor(descriptor);
    if (returnType !== "V" && returnType !== "void" && result !== undefined) {
      if (typeof result === "boolean") {
        result = result ? 1 : 0;
      }
      frame.stack.push(result);
    }
    return;
  }

  // Special handling for annotation proxy objects
  if (boxedObj._annotationData) {
    const methodKey = methodName + descriptor;
    if (typeof boxedObj[methodKey] === "function") {
      const result = boxedObj[methodKey]();
      const { returnType } = parseDescriptor(descriptor);
      if (returnType !== "V" && returnType !== "void" && result !== undefined) {
        frame.stack.push(result);
      }
      return;
    }
  }

  // First check JRE methods
  let currentClassName = receiverClassName;
  while (currentClassName) {
    let jreMethod = null;
    if (jvm.jre[currentClassName]) {
      jreMethod = jvm._jreFindMethod(currentClassName, methodName, descriptor);
    }
    if (jreMethod) {
      let result = jreMethod(jvm, boxedObj, args, thread);
      if (result && typeof result.then === 'function') {
        result = await result;
      }
      if (result !== ASYNC_METHOD_SENTINEL) {
        const { returnType } = parseDescriptor(descriptor);
        if (returnType !== "V" && returnType !== "void" && result !== undefined) {
          if (typeof result === "boolean") {
            result = result ? 1 : 0;
          }
          frame.stack.push(result);
        }
      }
      return;
    }

    let classData = jvm.classes[currentClassName];
    const isKnownJreClass = !!jvm.jre[currentClassName];
    if (classData && classData.isJreStub && !isKnownJreClass) {
      const loadedClassData = await jvm.loadClassByName(currentClassName);
      if (loadedClassData && !loadedClassData.isJreStub) {
        classData = loadedClassData;
      }
    }
    if (!classData) {
      if (isKnownJreClass) {
        break; // Platform JRE shims are runtime-only.
      }
      classData = await jvm.loadClassByName(currentClassName);
      if (!classData && jvm.jre[currentClassName]) {
        break;
      }
    }

    if (classData) {
      const method = jvm.findMethod(classData, methodName, descriptor);
      if (method) {
        // Validate that the method is not static for invokeinterface
        if (method.flags && method.flags.includes("static")) {
          throw new Error(
            `IncompatibleClassChangeError: invokeinterface called on static method ${currentClassName}.${methodName}${descriptor}`
          );
        }

        const newFrame = new Frame(method);
        newFrame.className = currentClassName; // Add className to the frame
        newFrame.locals[0] = boxedObj; // 'this'
        assignArgsToLocals(newFrame.locals, args, params, 1);
        thread.callStack.push(newFrame);
        return;
      }
      const defaultTarget = await resolveDefaultInterfaceMethod(
        jvm,
        classData.ast.classes[0].interfaces,
        methodName,
        descriptor,
      );
      if (defaultTarget) {
        const newFrame = new Frame(defaultTarget.method);
        newFrame.className = defaultTarget.className;
        newFrame.locals[0] = boxedObj;
        assignArgsToLocals(newFrame.locals, args, params, 1);
        thread.callStack.push(newFrame);
        return;
      }
      currentClassName = classData.ast.classes[0].superClassName;
    } else {
      currentClassName = null;
    }
  }

  throw new Error(
    `Unsupported invokeinterface: ${runtimeClassName(boxedObj)}.${methodName}${descriptor}`,
  );
}

const invokeHandlers = {
  invokevirtual,
  invokestatic,
  invokespecial,
  invokedynamic,
  invokeinterface,
};

invokeHandlers.invokevirtualSync = (frame, instruction, jvm, thread) =>
  invokeBytecodeSync(frame, instruction, jvm, thread, 'virtual');
invokeHandlers.invokestaticSync = (frame, instruction, jvm, thread) =>
  invokeBytecodeSync(frame, instruction, jvm, thread, 'static');
invokeHandlers.invokespecialSync = (frame, instruction, jvm, thread) =>
  invokeBytecodeSync(frame, instruction, jvm, thread, 'special');
invokeHandlers.invokeinterfaceSync = (frame, instruction, jvm, thread) =>
  invokeBytecodeSync(frame, instruction, jvm, thread, 'interface');
invokeHandlers.SYNC_INVOKE_FALLBACK = SYNC_INVOKE_FALLBACK;

module.exports = invokeHandlers;

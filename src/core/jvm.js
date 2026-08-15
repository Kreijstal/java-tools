const Stack = require("./stack");
const CallStack = require("./callStack");
const { releaseFrameMonitor } = CallStack;
const FRAME_STATIC_KIND = Symbol("frame.staticKind");
const {
  loadClassByPath,
  loadClassByPathSync: loadConvertedClass,
} = require("./classLoader");
const { parseDescriptor } = require("../parsing/typeParser");
const { primitiveTypeDescriptors, arrayPrimitiveTypeDescriptors } = require("./constants");
const {
  formatInstruction,
  unparseDataStructures,
  convertJson,
} = require("../parsing/convert_tree");
const jreClasses = require("../jre");
const dispatch = require("../instructions");
const {
  prepareSyncInstructions,
  syncHandler,
  syncInstruction,
  syncFallback,
  syncInvokeFallback,
} = dispatch;
const {
  isReflectiveTarget,
  completeReflectiveCall,
} = require("../instructions/control");
const Frame = require("./frame");
const DebugManager = require("../debug/DebugManager");
const JNI = require("./jni");
const fs = require("fs");
const path = require("path");
const { getAST } = require("jvm_parser");
const JSZip = require("jszip");
const { JreBootstrap } = require("./jre-bootstrap");
const JitCompiler = require("../jit/JitCompiler");
const { encodeGraph, decodeGraph } = require("./stateCodec");
const { createClock } = require('./fakeClock');
const {
  newFields, loadHierarchy, makeObjectRef,
} = require('./objectModel');

class ClassInitializationStateMap extends Map {
  constructor(jvm, entries = []) {
    super();
    this.jvm = jvm;
    for (const [className, state] of entries) super.set(className, state);
  }

  set(className, state) {
    const previous = super.get(className);
    super.set(className, state);
    if (previous !== state && Number.isFinite(
      this.jvm?.classInitializationEpoch)) {
      this.jvm.classInitializationEpoch += 1;
    }
    const token = this.jvm?.classInitializationTokens?.get(className);
    if (token) {
      token.state = state;
      token.initialized = state === "INITIALIZED";
    }
    return this;
  }

  delete(className) {
    const deleted = super.delete(className);
    if (deleted && Number.isFinite(this.jvm?.classInitializationEpoch)) {
      this.jvm.classInitializationEpoch += 1;
    }
    const token = this.jvm?.classInitializationTokens?.get(className);
    if (token) {
      token.state = undefined;
      token.initialized = false;
    }
    return deleted;
  }
}

let browserYieldChannel = null;
const browserYieldQueue = [];

function yieldToEventLoop(delayMs = 0, strategy = "message-channel") {
  return new Promise((resolve) => {
    if (delayMs > 0) {
      setTimeout(resolve, delayMs);
    } else if (typeof setImmediate === "function") {
      setImmediate(resolve);
    } else if (strategy === "timer" || typeof MessageChannel !== "function") {
      // A timer gives the browser's rendering opportunity a task-queue
      // boundary. Firefox can otherwise keep selecting a continuously
      // replenished MessageChannel queue while requestAnimationFrame remains
      // pending, coalescing many completed guest frames without painting.
      setTimeout(resolve, 0);
    } else {
      // Browser setTimeout(0) is clamped after repeated scheduling. The JVM
      // reaches this safe point every wall-clock slice, so that clamp can
      // consume a material fraction of a render frame. MessageChannel avoids
      // that delay, but callers should select the timer strategy when their
      // browser prioritizes message tasks ahead of rendering opportunities.
      if (!browserYieldChannel) {
        browserYieldChannel = new MessageChannel();
        browserYieldChannel.port1.onmessage = () => {
          const resume = browserYieldQueue.shift();
          if (resume) resume();
        };
      }
      browserYieldQueue.push(resolve);
      browserYieldChannel.port2.postMessage(0);
    }
  });
}

const BURST_TICK_OPTIONS = Object.freeze({ allowBurst: true });
const TICK_CONTINUE = Object.freeze({ completed: false });
const TICK_COMPLETE = Object.freeze({ completed: true });
const JIT_TICK_SLOW = Object.freeze({ slow: true, skipJit: false });
const JIT_TICK_SLOW_AFTER_PROBE = Object.freeze({ slow: true, skipJit: true });
const PRIMITIVE_ARRAY_COMPONENTS = new Set(["Z", "B", "C", "S", "I", "J", "F", "D"]);

function staticFieldInitialValue(jvm, field) {
  const descriptor = field && field.descriptor;
  let value = field && field.value;
  const hasConstantValue = value !== null && value !== undefined;
  if (hasConstantValue && value && typeof value === "object"
      && Object.prototype.hasOwnProperty.call(value, "value")) {
    value = value.value;
  }
  if (hasConstantValue) {
    if (descriptor === "Ljava/lang/String;") return jvm.internString(value);
    if (descriptor === "J") {
      if (typeof value === "bigint") return value;
      return BigInt(String(value).replace(/[lL]$/, ""));
    }
    if (descriptor === "F") return Math.fround(Number(value));
    if (descriptor === "D") return Number(value);
    if (["Z", "B", "C", "S", "I"].includes(descriptor)) return Number(value) | 0;
  }
  if (descriptor === "J") return BigInt(0);
  if (["Z", "B", "C", "S", "I", "F", "D"].includes(descriptor)) return 0;
  return null;
}

function arrayComponentType(descriptor) {
  if (typeof descriptor !== "string" || descriptor[0] !== "[") return null;
  const component = descriptor.slice(1);
  if (component.length === 1 && PRIMITIVE_ARRAY_COMPONENTS.has(component)) {
    return { primitive: true, name: component };
  }
  if (component[0] === "L" && component.endsWith(";")) {
    return { primitive: false, name: component.slice(1, -1) };
  }
  if (component[0] === "[") {
    return { primitive: false, name: component };
  }
  return null;
}

class JVM {
  constructor(options = {}) {
    this.threads = [];
    this.currentThreadIndex = 0;
    this.classes = {}; // className -> { ast, constantPool }
    this._methodClassNames = new WeakMap();
    this._indexedMethodClassData = new Map();
    // Bumped on every class registration; closed-world analyses (class
    // hierarchy, devirtualization facts) memoize against it.
    this.classEpoch = 0;
    this.classInitializationState = new ClassInitializationStateMap(this);
    this.classInitializationOwners = new Map();
    // Generated call/field sites retain these stable token objects. Java
    // class initialization is monotonic during ordinary execution, so a hot
    // site can read one boolean property instead of performing a Map lookup
    // on every invocation. State restoration refreshes the existing tokens
    // before generated code is discarded or resumed.
    this.classInitializationTokens = new Map();
    // Separate from classEpoch because a loaded class can become initialized
    // without registering another class. Link-time JIT decisions that depend
    // on initialized statics memoize against both epochs.
    this.classInitializationEpoch = 0;
    this.invokedynamicCache = new Map();
    this.classObjectCache = new Map(); // className -> Class object (for maintaining identity)
    this.jarCache = new Map(); // jarPath -> JSZip instance
    // Class loading is asynchronous in both Node and the browser. Multiple
    // guest threads may request the same previously unseen class before the
    // first archive read completes. Keep one in-flight load per normalized
    // name so a later completion cannot replace an initialized class with a
    // fresh static-field map.
    this.classLoadPromises = new Map();
    this.jre = jreClasses;
    this.debugManager = new DebugManager();
    const env = (typeof process !== 'undefined' && process.env) || {};
    this.classpath = options.classpath
      ? Array.isArray(options.classpath)
        ? options.classpath
        : [options.classpath]
      : ["."];
    this.verbose = options.verbose || false;
    this._debugGetfield = env.JVM_DEBUG_GETFIELD || null;
    this._debugPutfield = env.JVM_DEBUG_PUTFIELD || null;
    this._debugPutfieldStack = Boolean(env.JVM_DEBUG_PUTFIELD_STACK);
    this.appletParameters = options.appletParameters || null;
    this.appletCodeBase = options.appletCodeBase || null;
    this.nextHashCode = 1;
    const configuredMaxStackDepth = Number(
      options.maxStackDepth ?? env.JVM_MAX_STACK_DEPTH);
    this.maxStackDepth = Number.isSafeInteger(configuredMaxStackDepth) &&
      configuredMaxStackDepth > 0 ? configuredMaxStackDepth : 1024;
    // Linear heap for primitive arrays: TypedArray views over one wasm
    // memory, so compiled code can access elements without import crossings.
    const wasmHeapEnabled = options.wasmHeap ?? env.JVM_WASM_HEAP === '1';
    const wasmHeapMb = Number(options.wasmHeapMb ?? env.JVM_WASM_HEAP_MB) || 256;
    this.wasmHeap = wasmHeapEnabled
      ? new (require('./wasmHeap').WasmHeap)(wasmHeapMb)
      : null;
    // Primitive instance fields in that same memory at static per-class
    // offsets (see core/objectModel.js). Requires the heap; off by default.
    this.wasmFields = !!this.wasmHeap &&
      (options.wasmFields ?? env.JVM_WASM_FIELDS === '1');
    this.clock = options.clock || createClock({
      fakeTime: options.fakeTime ?? env.JVM_FAKE_TIME,
      fakeTimeStep: options.fakeTimeStep ?? env.JVM_FAKE_TIME_STEP,
      fakeTimeRealtime: options.fakeTimeRealtime ?? env.JVM_FAKE_TIME_REALTIME === '1',
    });
    const configuredYieldMs = options.eventLoopYieldMs ?? env.JVM_EVENT_LOOP_YIELD_MS;
    this.eventLoopYieldMs = Math.max(1, Number(configuredYieldMs) || 16);
    const configuredYieldStrategy =
      options.eventLoopYieldStrategy ?? env.JVM_EVENT_LOOP_YIELD_STRATEGY;
    this.eventLoopYieldStrategy =
      configuredYieldStrategy === "message-channel"
        ? "message-channel" : "timer";
    const configuredBurst = options.interpreterBurst ??
      env.JVM_INTERPRETER_BURST;
    this.interpreterBurst = Math.max(1, Number(configuredBurst) || 1024);
    const configuredGeneratedBurst = options.generatedSchedulerBurst ??
      env.JVM_GENERATED_SCHEDULER_BURST;
    this.generatedSchedulerBurst = Math.max(1,
      Math.min(256, Number(configuredGeneratedBurst) || 64));
    this.generatedSchedulerBurstFrames = 0;
    this.generatedSchedulerBurstBatches = 0;
    this._nextEventLoopYieldAt = Date.now() + this.eventLoopYieldMs;
    this._hotMethodCounts = new Map();
    // process.env property reads go through libuv (~600ns for the set below);
    // executeTick consults these every tick, so latch them once here.
    this._envTrace = !!env.JVM_TRACE;
    this._envProfileHot = env.JVM_PROFILE_HOT_METHODS === '1' ||
      env.JVM_PROFILE_HOT_METHODS_WITH_JIT === '1';
    const schedulerTimingRate = Number(
      options.schedulerTimingRate ?? env.JVM_PROFILE_SCHEDULER_TIMES);
    this._schedulerTimingProfile = Number.isFinite(schedulerTimingRate) && schedulerTimingRate > 0
      ? { rate: Math.max(1, Math.floor(schedulerTimingRate)), random: 0x9e3779b9,
        methods: new WeakMap(), samples: new Map() }
      : null;
    this._envDebugThrow = !!env.JVM_DEBUG_THROW;
    this._envDebugThrowType = env.JVM_DEBUG_THROW_TYPE || null;
    this.jitOptions = options.jit || {};
    this.jit = new JitCompiler(this, this.jitOptions);

    // Make fs and path available for JreBootstrap (only in Node.js environment)
    if (typeof window === "undefined") {
      this.fs = fs;
      this.path = path;
    }

    // Initialize JNI system
    this.jni = new JNI(this);
    this._jreMethodCache = new Map();
    this._jreMethodCacheVersion = this.jni.registryVersion;
    if (options.verbose) {
      this.jni.setVerbose(true);
    }

    if (options.jreOverrides) {
      this.registerJreOverrides(options.jreOverrides);
    }

    // Use JreBootstrap to preload all JRE classes
    JreBootstrap.preloadAllJreClasses(this);
  }

  throwException(exceptionClass, message) {
    const exception = { type: exceptionClass };
    if (message) {
      exception.message = this.internString(message);
    }
    throw exception;
  }

  internString(str) {
    if (str && str.type === "java/lang/String") {
      return str;
    }
    if (str && typeof str === "object" && Object.prototype.hasOwnProperty.call(str, "value")) {
      str = str.value;
    }
    str = String(str);
    // Proper string interning - reuse the same object for the same string value
    if (!this.stringPool) {
      this.stringPool = new Map();
    }

    if (this.stringPool.has(str)) {
      return this.stringPool.get(str);
    }

    // Create a string object with proper type property for invokevirtual
    const stringObj = new String(str);
    stringObj.type = "java/lang/String";
    this.stringPool.set(str, stringObj);
    return stringObj;
  }

  newString(str) {
    // Creates a new Java String object, without adding it to the string pool.
    // This is for methods that are required to return a new String instance.
    const stringObj = new String(str);
    stringObj.type = "java/lang/String";
    return stringObj;
  }

  createStringArray(strings = []) {
    const array = new Array(strings.length);
    for (let i = 0; i < strings.length; i++) {
      array[i] = this.internString(strings[i]);
    }
    array.type = "[Ljava/lang/String;";
    array.elementType = "java/lang/String";
    array.length = strings.length;
    array.hashCode = this.nextHashCode++;
    return array;
  }

  newByteArray(buffer) {
    return {
      type: '[B',
      array: new Int8Array(buffer)
    };
  }

  registerJreMethods(methods) {
    for (const className in methods) {
      if (!this.jre[className]) {
        this.jre[className] = { methods: {} };
      }
      if (!this.jre[className].methods) {
        this.jre[className].methods = {};
      }
      for (const methodSig in methods[className]) {
        this.jre[className].methods[methodSig] = methods[className][methodSig];
      }
    }
  }

  /**
   * Comprehensive JVM override system that can override:
   * - Methods (instance and static)
   * - Private methods
   * - Constructors (<init> and <clinit>)
   * - Properties/Fields (static and instance)
   * - Entire classes
   * - And other JRE components
   */
  registerJreOverrides(overrides) {
    if (this._jreMethodCache) this._jreMethodCache.clear();
    for (const className in overrides) {
      const classOverrides = overrides[className];

      // Initialize class entry if it doesn't exist
      if (!this.jre[className]) {
        this.jre[className] = {};
      }

      // Handle complete class replacement
      if (classOverrides.__replaceClass) {
        this.jre[className] = { ...classOverrides.__replaceClass };
        continue;
      }

      // Handle method overrides (instance, static, private, constructors)
      if (classOverrides.methods) {
        if (!this.jre[className].methods) {
          this.jre[className].methods = {};
        }
        Object.assign(this.jre[className].methods, classOverrides.methods);
      }

      // Handle static field overrides
      if (classOverrides.staticFields) {
        if (!this.jre[className].staticFields) {
          this.jre[className].staticFields = new Map();
        }
        for (const [fieldName, fieldValue] of Object.entries(
          classOverrides.staticFields,
        )) {
          this.jre[className].staticFields.set(fieldName, fieldValue);
        }
      }

      // Handle instance field overrides (field initializers)
      if (classOverrides.instanceFields) {
        if (!this.jre[className].instanceFields) {
          this.jre[className].instanceFields = {};
        }
        Object.assign(
          this.jre[className].instanceFields,
          classOverrides.instanceFields,
        );
      }

      // Handle superclass override
      if (classOverrides.super) {
        this.jre[className].super = classOverrides.super;
      }

      // Handle interface implementations
      if (classOverrides.interfaces) {
        if (!this.jre[className].interfaces) {
          this.jre[className].interfaces = [];
        }
        this.jre[className].interfaces.push(...classOverrides.interfaces);
      }

      // Handle native properties/constants
      if (classOverrides.natives) {
        Object.assign(this.jre[className], classOverrides.natives);
      }
    }
  }

  _jreFindMethod(className, methodName, descriptor) {
    if (this._jreMethodCacheVersion !== this.jni.registryVersion) {
      this._jreMethodCache.clear();
      this._jreMethodCacheVersion = this.jni.registryVersion;
    }
    let classCache = this._jreMethodCache.get(className);
    if (!classCache) {
      classCache = new Map();
      this._jreMethodCache.set(className, classCache);
    }
    let methodCache = classCache.get(methodName);
    if (!methodCache) {
      methodCache = new Map();
      classCache.set(methodName, methodCache);
    }
    if (methodCache.has(descriptor)) return methodCache.get(descriptor);
    const remember = (method) => {
      const resolved = method || null;
      methodCache.set(descriptor, resolved);
      return resolved;
    };
    let resolvedClassName = className;
    const visited = new Set();
    while (resolvedClassName && !this.jre[resolvedClassName] &&
           !visited.has(resolvedClassName)) {
      visited.add(resolvedClassName);
      const nativeMethod = this.jni.findNativeMethod(
        resolvedClassName,
        methodName,
        descriptor,
      );
      if (nativeMethod) return remember(nativeMethod);

      const classData = this.classes[resolvedClassName];
      const classAst = classData && classData.ast &&
        classData.ast.classes && classData.ast.classes[0];
      if (!classAst) return remember(null);
      const guestOverride = (classAst.items || []).some((item) =>
        item.type === "method" && item.method &&
        item.method.name === methodName &&
        item.method.descriptor === descriptor);
      if (guestOverride) return remember(null);
      resolvedClassName = classAst.superClassName || null;
    }
    if (!resolvedClassName) return remember(null);

    const nativeMethod = this.jni.findNativeMethod(
      resolvedClassName,
      methodName,
      descriptor,
    );
    if (nativeMethod) return remember(nativeMethod);

    // Continue with original JRE method lookup.  Several existing JRE
    // shims use either `super: "java/lang/Object"` or
    // `super: { type: "java/lang/Object" }`; normalize both forms so
    // method lookup works consistently through the JRE hierarchy.
    let currentClass = this.jre[resolvedClassName];
    while (currentClass) {
      const methodKey = `${methodName}${descriptor}`;

      // Check instance methods
      const method = currentClass.methods && currentClass.methods[methodKey];
      if (method) {
        return remember(method);
      }

      // Check static methods
      const staticMethod =
        currentClass.staticMethods && currentClass.staticMethods[methodKey];
      if (staticMethod) {
        return remember(staticMethod);
      }

      // Check superclass
      let superName = currentClass.super;
      if (superName && typeof superName === "object") {
        superName = superName.type || null;
      }
      currentClass = superName ? this.jre[superName] : null;
    }

    // If no exact match found and this is a MethodHandle.invoke method,
    // try the universal varargs signature that can handle any parameters
    if (className === 'java/lang/invoke/MethodHandle' && methodName === 'invoke') {
      const methodHandleClass = this.jre['java/lang/invoke/MethodHandle'];
      if (methodHandleClass && methodHandleClass.methods) {
        const universalMethod = methodHandleClass.methods['invoke([Ljava/lang/Object;)Ljava/lang/Object;'];
        if (universalMethod) {
          return remember(universalMethod);
        }
      }
    }

    return remember(null);
  }


  async _initializeStaticFields(classData) {
    if (classData.staticFields) {
      return; // Already initialized
    }

    classData.staticFields = {};

    // Initialize static fields with default values
    const fields = classData.ast.classes[0].items.filter(
      (item) =>
        item.type === "field" &&
        item.field.flags &&
        item.field.flags.includes("static"),
    );

    for (const fieldItem of fields) {
      const field = fieldItem.field;
      const fieldKey = `${field.name}:${field.descriptor}`;

      classData.staticFields[fieldKey] = staticFieldInitialValue(this, field);
    }

    // Execute static initializer (<clinit>) if it exists
    const staticInitializer = classData.ast.classes[0].items.find(
      (item) => item.type === "method" && item.method.name === "<clinit>",
    );

    if (staticInitializer) {
      // Execute the static initializer
      const thread = this.threads[this.currentThreadIndex];
      const frame = new Frame(staticInitializer.method, []);
      frame.className = className; // Add className to the frame
      thread.callStack.push(frame);

      // Execute until the static initializer completes
      while (
        !thread.callStack.isEmpty() &&
        thread.callStack.peek().method === staticInitializer.method
      ) {
        const result = await this.executeTick({ allowBurst: true });
        if (result.completed) break;
      }
    }
  }

  _jreGetNative(className, nativeName) {
    // First check JNI registry for native methods
    const nativeMethod = this.jni.findNativeMethod(className, nativeName, "");
    if (nativeMethod) {
      return nativeMethod;
    }

    // Fallback to legacy JRE lookup for backward compatibility
    return this.jre[className][nativeName];
  }

  /**
   * Register a native method implementation
   * @param {string} className - Java class name
   * @param {string} methodName - Method name
   * @param {string} descriptor - Method descriptor
   * @param {function} implementation - Native implementation function
   * @param {object} options - Additional options
   */
  registerNativeMethod(
    className,
    methodName,
    descriptor,
    implementation,
    options = {},
  ) {
    return this.jni.registerNativeMethod(
      className,
      methodName,
      descriptor,
      implementation,
      options,
    );
  }

  /**
   * Load a native library
   * @param {string} libraryName - Name of the library
   * @param {string|object} libraryPath - Path to JS module or library object
   * @param {object} options - Loading options
   */
  loadNativeLibrary(libraryName, libraryPath, options = {}) {
    return this.jni.loadLibrary(libraryName, libraryPath, options);
  }

  /**
   * Check if a method is registered as native
   * @param {string} className - Java class name
   * @param {string} methodName - Method name
   * @param {string} descriptor - Method descriptor
   * @returns {boolean}
   */
  hasNativeMethod(className, methodName, descriptor) {
    return this.jni.hasNativeMethod(className, methodName, descriptor);
  }

  /**
   * Get all registered native methods for debugging/introspection
   * @param {string} className - Optional class name filter
   * @returns {Array} - Array of native method descriptors
   */
  getNativeMethods(className = null) {
    if (className) {
      return this.jni.getClassNativeMethods(className);
    } else {
      // Return all native methods
      const allMethods = [];
      for (const [key, _] of this.jni.nativeRegistry) {
        const parts = key.split(":");
        allMethods.push({
          className: parts[0],
          methodName: parts[1],
          descriptor: parts[2],
        });
      }
      return allMethods;
    }
  }

  async run(mainClassName, options = {}) {
    if (options.classpath) {
      this.classpath = Array.isArray(options.classpath) ? options.classpath : [options.classpath];
    }

    // Clear existing threads when starting a new program execution
    this.threads = [];
    this.currentThreadIndex = 0;

    const classData = await this.loadClassByName(mainClassName);
    if (!classData || !classData.ast) {
      throw new Error(`Class not found: ${mainClassName}`);
    }

    const mainMethod = this.findMainMethod(classData);
    const isApplet = await this.isAppletClassAsync(classData);
    
    if (!mainMethod && !isApplet) {
      /* HARDENED: Replaced quiet failure with an explicit error */
      throw new Error("main method not found");
    }

    const mainThread = {
      id: 0,
      name: "main",
      callStack: new CallStack(),
      status: "runnable",
      pendingException: null,
    };
    this.threads.push(mainThread);

    // Initialize the main class before running main method or creating applet
    // This ensures static blocks execute before main method starts
    const className = classData.ast.classes[0].className;
    let wasFramePushed = await this.initializeClassIfNeeded(
      className,
      mainThread,
    );

    while (wasFramePushed) {
      // If a <clinit> frame was pushed, execute it to completion, then retry
      // initialization. A superclass initializer may have been pushed first.
      const originalStackSize = mainThread.callStack.size();
      while (mainThread.callStack.size() >= originalStackSize) {
        const result = await this.executeTick();
        if (result.completed) break;
      }
      wasFramePushed = await this.initializeClassIfNeeded(className, mainThread);
    }

    if (isApplet) {
      // Handle applet execution
      await this.runApplet(className, mainThread);
    } else {
      // Handle regular class with main method
      const mainFrame = new Frame(mainMethod);
      mainFrame.className = className; // Add className to the frame
      const mainArgs =
        Array.isArray(options.args) && options.args.length
          ? options.args
          : [];
      mainFrame.locals[0] = this.createStringArray(mainArgs);
      mainThread.callStack.push(mainFrame);
    }

    if (!this.debugManager.debugMode || !this.debugManager.isPaused) {
      await this.execute();
    }
  }

  async runApplet(className, mainThread) {
    // Create applet instance with proper field initialization
    const appletObj = await this.createAppletInstance(className);
    
    // In debug mode, set up applet for step-by-step debugging
    if (this.debugManager.debugMode && this.debugManager.isPaused) {
      return this.setupAppletDebugMode(className, mainThread, appletObj);
    }

    // Non-debug mode: execute all methods to completion (original behavior)
    return this.executeAppletLifecycle(className, mainThread, appletObj);
  }

  async executeUntilStackBelow(thread, stackSize) {
    while (thread.callStack.size() >= stackSize) {
      const result = await this.executeTick();
      if (result.completed) break;
      // Applet constructor/init/start execution happens before execute() owns
      // the scheduler. Maintain the same wall-clock yield deadline here so a
      // generated safe point does not see one permanently expired deadline
      // and repeatedly materialize the rest of a lifecycle method.
      if (Date.now() >= this._nextEventLoopYieldAt) {
        await yieldToEventLoop(0, this.eventLoopYieldStrategy);
        this._nextEventLoopYieldAt = Date.now() + this.eventLoopYieldMs;
      }
    }
  }

  async createAppletInstance(className, threadOverride = null) {
    // Ensure class is loaded
    const thread = threadOverride || this.threads[0];
    let wasFramePushed = await this.initializeClassIfNeeded(className, thread);
    while (wasFramePushed) {
      const originalStackSize = thread.callStack.size();
      await this.executeUntilStackBelow(thread, originalStackSize);
      wasFramePushed = await this.initializeClassIfNeeded(className, thread);
    }
    /* HARDENED: Rethrow with more context */
    await this.loadClassByName(className).catch(err => {
      throw new Error(`createAppletInstance failed: could not load class ${className}`, { cause: err });
    });

    // Initialize fields properly like the 'new' instruction does
    await loadHierarchy(this, className);
    const objRef = makeObjectRef(this, className, newFields(this, className));
    if (this.appletParameters) {
      objRef._parameters = this.appletParameters;
    }
    if (this.appletCodeBase) {
      objRef._codeBase = this.appletCodeBase;
    }

    // Add JavaScript toString method that calls Java toString
    const jvm = this;
    objRef.toString = function() {
      // Try to find toString method in the class hierarchy
      const currentType = this._className || this.type;
      let toStringMethod = null;

      // First check if it's a JRE class
      toStringMethod = jvm._jreFindMethod(currentType, 'toString', '()Ljava/lang/String;');

      // If not found, check parent classes
      if (!toStringMethod) {
        const classData = jvm.classes[currentType];
        if (classData && classData.ast && classData.ast.classes[0].superClassName) {
          const superClassName = classData.ast.classes[0].superClassName;
          toStringMethod = jvm._jreFindMethod(superClassName, 'toString', '()Ljava/lang/String;');
        }
      }

      if (toStringMethod) {
        const result = toStringMethod(jvm, this, []);
        return (result && result.value !== undefined) ? result.value : currentType.split('/').pop();
      }
      return currentType.split('/').pop();
    };
    
    return objRef;
  }

  async setupAppletDebugMode(className, mainThread, appletObj) {
    // Store minimal applet info for method sequencing
    mainThread.appletInfo = {
      instance: appletObj,
      className: className,
      nextMethods: ['<init>', 'init', 'start', 'paint']
    };

    // Start with constructor - this will be debugged step-by-step
    await this.setupNextAppletMethod(mainThread);
  }

  // Helper method to create a proper Graphics object connected to DOM canvas
  createGraphicsObject(appletObj) {
    // Try to find the canvas element from the applet object
    let canvas = null;
    let awtGraphics = null;

    if (appletObj && typeof document !== 'undefined') {
      // First, try to get the canvas from the applet object's canvas element
      if (appletObj._canvasElement) {
        canvas = appletObj._canvasElement;
      } else if (appletObj._awtComponent && appletObj._awtComponent.canvasElement) {
        canvas = appletObj._awtComponent.canvasElement;
      } else {
        // Look for AWT container and find canvas within it
        const awtContainer = document.getElementById('awt-container');
        if (awtContainer) {
          canvas = awtContainer.querySelector('canvas');
        }
      }

      // If we found a canvas, create a proper graphics context
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          // Import the AWT framework to create CanvasGraphics
          const awtFramework = require('../platform/awt.js');
          awtGraphics = new awtFramework.CanvasGraphics(ctx);
        }
      }
    }

    // Create the Java Graphics object with proper connection
    const graphicsObj = {
      type: 'java/awt/Graphics',
      _awtGraphics: awtGraphics
    };

    if (awtGraphics) {
      // Connect to real canvas graphics context
      graphicsObj._awtGraphics = awtGraphics;
    } else {
      // Fallback to mock graphics for environments without DOM
      graphicsObj.isMock = true;
    }

    return graphicsObj;
  }

  async setupNextAppletMethod(mainThread) {
    const appletInfo = mainThread.appletInfo;
    if (!appletInfo || appletInfo.nextMethods.length === 0) {
      // No more methods to set up
      delete mainThread.appletInfo;
      return;
    }

    const methodName = appletInfo.nextMethods.shift();
    const className = appletInfo.className;
    const appletObj = appletInfo.instance;

    if (methodName === '<init>') {
      const constructorMethod = this.findMethod({ ast: this.classes[className].ast }, '<init>', '()V');
      if (constructorMethod) {
        const constructorFrame = new Frame(constructorMethod);
        constructorFrame.className = className;
        constructorFrame.locals[0] = appletObj;
        mainThread.callStack.push(constructorFrame);
        return;
      }
    } else if (methodName === 'init') {
      const initMethod = await this.findMethodInHierarchy(className, 'init', '()V');
      if (initMethod) {
        const initFrame = new Frame(initMethod);
        initFrame.className = className;
        initFrame.locals[0] = appletObj;
        mainThread.callStack.push(initFrame);
        return;
      }
    } else if (methodName === 'start') {
      const startMethod = await this.findMethodInHierarchy(className, 'start', '()V');
      if (startMethod) {
        const startFrame = new Frame(startMethod);
        startFrame.className = className;
        startFrame.locals[0] = appletObj;
        mainThread.callStack.push(startFrame);
        return;
      }
    } else if (methodName === 'paint') {
      const paintMethod = await this.findMethodInHierarchy(
        className,
        'paint',
        '(Ljava/awt/Graphics;)V',
      );
      if (paintMethod) {
        const paintFrame = new Frame(paintMethod);
        paintFrame.className = className;
        paintFrame.locals[0] = appletObj;
        // Create proper Graphics object connected to DOM canvas
        const graphicsObj = this.createGraphicsObject(appletObj);
        paintFrame.locals[1] = graphicsObj;
        mainThread.callStack.push(paintFrame);
        return;
      }
    }

    // If method not found, try next method recursively
    await this.setupNextAppletMethod(mainThread);
  }

  async executeAppletLifecycle(className, mainThread, appletObj) {
    // Original behavior: execute all methods to completion
    
    // Find and call constructor
    const constructorMethod = this.findMethod({ ast: this.classes[className].ast }, '<init>', '()V');
    if (constructorMethod) {
      mainThread.status = "runnable";
      const constructorFrame = new Frame(constructorMethod);
      constructorFrame.className = className;
      constructorFrame.locals[0] = appletObj;
      mainThread.callStack.push(constructorFrame);
      
      // Execute constructor to completion
      const originalStackSize = mainThread.callStack.size();
      await this.executeUntilStackBelow(mainThread, originalStackSize);
    }

    // Applet lifecycle methods are virtual. A concrete applet commonly keeps
    // init() on the leaf class while inheriting start() from a reusable game
    // shell, so resolve both through the normal class hierarchy.
    const initMethod = await this.findMethodInHierarchy(className, 'init', '()V');
    if (initMethod) {
      mainThread.status = "runnable";
      const initFrame = new Frame(initMethod);
      initFrame.className = className;
      initFrame.locals[0] = appletObj;
      mainThread.callStack.push(initFrame);
      
      // Execute init to completion
      const originalStackSize = mainThread.callStack.size();
      await this.executeUntilStackBelow(mainThread, originalStackSize);
    }

    const startMethod = await this.findMethodInHierarchy(className, 'start', '()V');
    if (startMethod) {
      mainThread.status = "runnable";
      const startFrame = new Frame(startMethod);
      startFrame.className = className;
      startFrame.locals[0] = appletObj;
      mainThread.callStack.push(startFrame);
      
      // Execute start to completion
      const originalStackSize = mainThread.callStack.size();
      await this.executeUntilStackBelow(mainThread, originalStackSize);
    }

    // Call repaint() to trigger paint method
    const repaintMethod = this.jre['java/applet/Applet'].methods['repaint()V'];
    if (repaintMethod) {
      mainThread.status = "runnable";
      await repaintMethod(this, appletObj, []);
    }
  }

  async execute() {
    this.debugManager.resume();

    try {
      while (!this.debugManager.isPaused) {
        const scheduled = this._prepareSchedulerTick();
        const timingSample = this._beginSchedulerTiming(scheduled);
        const fastResult = this._tryExecuteSynchronousJitTick(scheduled);
        let result;
        if (fastResult && fastResult.slow) {
          const interpreterResult = this._tryExecuteSynchronousInterpreterTick(
            scheduled, fastResult.skipJit);
          if (interpreterResult && interpreterResult.slow) {
            if (timingSample) timingSample.slowPath = true;
            result = this.executeTick(
              BURST_TICK_OPTIONS, scheduled, interpreterResult.skipJit);
          } else {
            result = interpreterResult;
          }
        } else {
          result = fastResult;
        }
        if (result && typeof result.then === "function") {
          if (timingSample) {
            timingSample.awaited = true;
            timingSample.beforeAwaitAt = performance.now();
          }
          result = await result;
        }
        this._endSchedulerTiming(timingSample);
        if (result.completed) {
          this.debugManager.pause();
          return { completed: true, paused: false };
        }

        // Check for breakpoints
        const currentThread = this.threads[this.currentThreadIndex];
        if (
          this.debugManager.breakpoints.size > 0 &&
          currentThread &&
          currentThread.status === "runnable" &&
          !currentThread.callStack.isEmpty()
        ) {
          const frame = currentThread.callStack.peek();
          if (frame) {
            // A thread's pc can be out of bounds if it just finished.
            if (frame.pc < frame.instructions.length) {
              const instructionItem = frame.instructions[frame.pc];
              if (instructionItem) {
                const label = instructionItem.labelDef;
                const currentPc = label
                  ? parseInt(label.substring(1, label.length - 1))
                  : -1;
                // A bare offset matches anywhere; a located breakpoint must
                // also match the frame's class/method, so an offset such as 6
                // no longer stops in every method that reaches it.
                if (this.debugManager.shouldBreakAt(currentPc, {
                  className: frame.className,
                  methodName: frame.method && frame.method.name,
                  descriptor: frame.method && frame.method.descriptor,
                })) {
                  this.debugManager.pause();
                }
              }
            }
          }
        }
        // Bytecode throughput varies drastically between interpreter and JIT
        // regions. A wall-clock budget keeps timers and I/O responsive without
        // making fast bytecodes pay excessive scheduler overhead.
        if (Date.now() >= this._nextEventLoopYieldAt) {
          await yieldToEventLoop(0, this.eventLoopYieldStrategy);
          this._nextEventLoopYieldAt = Date.now() + this.eventLoopYieldMs;
        }
      }
    } catch (e) {
      this.debugManager.pause();
      throw e;
    }

    return { paused: true, completed: false };
  }

  enqueueAwtEventInvocation(listener, methodName, descriptor, event, coalesce = false) {
    if (!listener || !listener.type || !methodName || !descriptor) return;
    if (!this._awtEventQueue) this._awtEventQueue = [];
    const record = { listener, methodName, descriptor, event };
    const tail = this._awtEventQueue[this._awtEventQueue.length - 1];
    if (coalesce && tail && tail.listener === listener &&
        tail.methodName === methodName && tail.descriptor === descriptor) {
      tail.event = event;
    } else {
      this._awtEventQueue.push(record);
    }
    this._scheduleAwtEventPump();
  }

  _scheduleAwtEventPump() {
    if (this._awtEventPumpTimer !== undefined) return;
    this._awtEventPumpTimer = setTimeout(async () => {
      delete this._awtEventPumpTimer;
      let thread = this._awtEventThread;
      if (thread && !thread.callStack.isEmpty()) {
        this._scheduleAwtEventPump();
        return;
      }
      const record = this._awtEventQueue && this._awtEventQueue.shift();
      if (!record) return;
      const method = await this.findMethodInHierarchy(
        record.listener.type, record.methodName, record.descriptor);
      if (method) {
        if (!thread) {
          thread = {
            id: this.threads.length,
            name: 'AWT-EventQueue-0',
            callStack: new CallStack(),
            status: 'terminated',
            pendingException: null,
          };
          this._awtEventThread = thread;
          this.threads.push(thread);
        }
        const frame = new Frame(method);
        frame.className = record.listener.type;
        frame.locals[0] = record.listener;
        frame.locals[1] = record.event;
        thread.callStack.push(frame);
        thread.status = 'runnable';
        this._awtInputDispatchCount = (this._awtInputDispatchCount || 0) + 1;
      }
      if (this._awtEventQueue.length || thread && !thread.callStack.isEmpty()) {
        this._scheduleAwtEventPump();
      }
    }, 4);
  }

  _beginSchedulerTiming(scheduled) {
    const profile = this._schedulerTimingProfile;
    if (!profile || !scheduled || !scheduled.thread) return null;
    profile.random = (Math.imul(profile.random, 1664525) + 1013904223) >>> 0;
    if (profile.random >= 0x100000000 / profile.rate) return null;
    const frame = scheduled.callStack && !scheduled.callStack.isEmpty()
      ? scheduled.callStack.peek() : null;
    if (!frame || !frame.method) return null;
    let key = profile.methods.get(frame.method);
    if (!key) {
      const owner = frame.className || this.findClassNameForMethod(frame.method) || '<unknown>';
      key = `${owner}.${frame.method.name}${frame.method.descriptor}`;
      profile.methods.set(frame.method, key);
    }
    return { key, started: performance.now() };
  }

  _endSchedulerTiming(sample) {
    if (!sample) return;
    const ended = performance.now();
    const elapsedMs = ended - sample.started;
    const synchronousMs =
      (sample.beforeAwaitAt === undefined ? ended : sample.beforeAwaitAt) -
      sample.started;
    const asyncWaitMs = sample.beforeAwaitAt === undefined
      ? 0
      : ended - sample.beforeAwaitAt;
    const samples = this._schedulerTimingProfile.samples;
    const previous = samples.get(sample.key) || {
      samples: 0,
      totalMs: 0,
      maxMs: 0,
      synchronousMs: 0,
      asyncWaitMs: 0,
      awaitedSamples: 0,
      slowPathSamples: 0,
    };
    previous.samples += 1;
    previous.totalMs += elapsedMs;
    previous.maxMs = Math.max(previous.maxMs, elapsedMs);
    previous.synchronousMs += synchronousMs;
    previous.asyncWaitMs += asyncWaitMs;
    if (sample.awaited) previous.awaitedSamples += 1;
    if (sample.slowPath) previous.slowPathSamples += 1;
    samples.set(sample.key, previous);
  }

  dumpSchedulerTimings(limit = 30) {
    const snapshot = this.getSchedulerTimingSnapshot(limit);
    if (!snapshot) return;
    console.error(`--- sampled scheduler wall time (1/${snapshot.rate}) ---`);
    for (const row of snapshot.rows) {
      console.error(`${row.totalMs.toFixed(3)}ms\t${row.samples}\t` +
        `${row.maxMs.toFixed(3)}ms max\t${row.method}`);
    }
  }

  getSchedulerTimingSnapshot(limit = 30) {
    const profile = this._schedulerTimingProfile;
    if (!profile) return null;
    const rows = [...profile.samples.entries()]
      .sort((a, b) => b[1].totalMs - a[1].totalMs)
      .slice(0, Math.max(1, Number(limit) || 30))
      .map(([method, value]) => ({
        method,
        samples: value.samples,
        totalMs: value.totalMs,
        maxMs: value.maxMs,
        synchronousMs: value.synchronousMs || 0,
        asyncWaitMs: value.asyncWaitMs || 0,
        awaitedSamples: value.awaitedSamples || 0,
        slowPathSamples: value.slowPathSamples || 0,
      }));
    return { rate: profile.rate, rows };
  }

  configureSchedulerTimings(rate = 0) {
    const numericRate = Number(rate);
    if (!Number.isFinite(numericRate) || numericRate <= 0) {
      this._schedulerTimingProfile = null;
      return null;
    }
    this._schedulerTimingProfile = {
      rate: Math.max(1, Math.floor(numericRate)),
      random: 0x9e3779b9,
      methods: new WeakMap(),
      samples: new Map(),
    };
    return this.getSchedulerTimingSnapshot();
  }

  resetSchedulerTimings() {
    const profile = this._schedulerTimingProfile;
    if (profile) profile.samples.clear();
  }

  _prepareSchedulerTick() {
    // On each tick, check for threads that need to be woken up.
    const audioPriority = this._audioPriority;
    const hasTimedThread = this.threads.some((t) =>
      (t.status === 'SLEEPING' && t.sleepUntil !== undefined) ||
      (t.status === 'WAITING' && t.waitDeadline !== undefined)) ||
      Boolean(audioPriority);
    const schedulerNow = hasTimedThread ? this.clock.millis() : 0;
    for (const t of this.threads) {
      if (t.status === "SLEEPING" && schedulerNow >= t.sleepUntil) {
        t.status = "runnable";
        delete t.sleepUntil;
      }
      if (t.status === "JOINING" && t.joiningOn.status === "terminated") {
        t.status = "runnable";
        delete t.joiningOn;
      }
      if (t.status === "CLASS_INITIALIZATION_WAIT" &&
          this.classInitializationState.get(t.waitingForClassInitialization) !==
            "INITIALIZING") {
        t.status = "runnable";
        delete t.waitingForClassInitialization;
      }
      if (
        t.status === "BLOCKED" &&
        t.blockingOn &&
        !t.blockingOn.isLocked &&
        !t.blockingOn._isReentrantLock
      ) {
        t.status = "runnable";
      }
      if (t.status === "WAITING" && t.waitDeadline && schedulerNow >= t.waitDeadline) {
        // Timed wait expired: leave the wait set and re-acquire the monitor.
        const monitor = t.waitingOn;
        if (monitor && Array.isArray(monitor.waitSet)) {
          const idx = monitor.waitSet.indexOf(t);
          if (idx >= 0) monitor.waitSet.splice(idx, 1);
        }
        t.status = "WAIT_REACQUIRE";
        t.blockingOn = monitor;
        delete t.waitingOn;
        delete t.waitDeadline;
      }
      if (t.status === "WAIT_REACQUIRE" && t.blockingOn && !t.blockingOn.isLocked) {
        // Execution resumes AFTER the wait call, so acquire on the thread's
        // behalf (monitorenter will not run again).
        t.blockingOn.isLocked = true;
        t.blockingOn.lockOwner = t.id;
        t.blockingOn.lockCount = t.waitLockCount || 1;
        delete t.blockingOn;
        delete t.waitLockCount;
        t.status = "runnable";
      }
    }

    if (this.threads.every((t) => t.status === "terminated")) {
      return { completed: true, schedulerNow };
    }

    // console.error(`Tick. Current thread: ${this.currentThreadIndex}. Statuses: ${this.threads.map(t => `${t.id}:${t.status}`).join(', ')}`);

    if (audioPriority && audioPriority.thread &&
        audioPriority.thread.status === "runnable" &&
        schedulerNow <= audioPriority.until &&
        audioPriority.output &&
        typeof audioPriority.output.queuedSeconds === "function" &&
        audioPriority.output.queuedSeconds() < 0.12) {
      const priorityIndex = this.threads.indexOf(audioPriority.thread);
      if (priorityIndex >= 0) this.currentThreadIndex = priorityIndex;
    } else if (audioPriority) {
      this._audioPriority = null;
    }

    let thread = this.threads[this.currentThreadIndex];

    // Find the next runnable thread
    const initialThreadIndex = this.currentThreadIndex;
    while (thread.status !== "runnable") {
      this.currentThreadIndex =
        (this.currentThreadIndex + 1) % this.threads.length;
      thread = this.threads[this.currentThreadIndex];
      if (this.currentThreadIndex === initialThreadIndex) {
        // The completion scan above proved at least one thread is parked.
        return { idle: true, schedulerNow };
      }
    }

    return { thread, callStack: thread.callStack, schedulerNow };
  }

  _advanceSchedulerThread() {
    const count = this.threads.length;
    if (count === 0) return;
    const current = this.threads[this.currentThreadIndex];
    // JVM.js multiplexes every Java thread onto one host JavaScript thread.
    // Weighting this serial scheduler by Thread.priority can therefore starve
    // a low-priority loader behind a permanently runnable animation thread;
    // HotSpot can schedule those threads concurrently and treats priority as
    // a platform-dependent hint. Preserve bounded progress with fair
    // round-robin scheduling. Deadline-sensitive audio uses the explicit
    // short-lived scheduler override in _prepareSchedulerTick instead.
    this.currentThreadIndex = (this.currentThreadIndex + 1) % count;
  }

  _tryExecuteSynchronousJitTick(scheduled) {
    if (scheduled.completed) return TICK_COMPLETE;
    if (scheduled.idle) return JIT_TICK_SLOW;

    const { thread, callStack } = scheduled;
    let completedFrames = 0;
    for (; completedFrames < this.generatedSchedulerBurst;
      completedFrames += 1) {
      if (callStack.size() > this.maxStackDepth || callStack.isEmpty()) break;
      const frame = callStack.peek();
      if (frame.pc >= frame.instructions.length ||
          thread.status !== "runnable") break;
      // This fast path enters the frame without going through executeTick, so
      // it owns the implied ACC_SYNCHRONIZED acquisition too. Contention ends
      // the burst and lets canonical scheduling park/resume the thread.
      if (frame.isSynchronizedMethod && !frame.monitorEntered &&
          !this.enterFrameMonitorIfNeeded(frame, thread)) break;

      let jitResult;
      try {
        jitResult = this.jit.tryRunFrame(frame, thread);
      } catch (error) {
        return this._failSynchronousJitTick(error, thread);
      }
      if (jitResult && typeof jitResult.then === "function") {
        return jitResult.then(
          (resolved) => this._finishSynchronousJitTick(resolved),
          (error) => this._failSynchronousJitTick(error, thread),
        );
      }
      if (!jitResult.handled) {
        if (completedFrames > 0) {
          this.generatedSchedulerBurstFrames += completedFrames;
          this.generatedSchedulerBurstBatches += 1;
        }
        return JIT_TICK_SLOW_AFTER_PROBE;
      }
      // Generated methods are already atomic between their own verified safe
      // points. Continue through the same Java thread's newly exposed child or
      // parent Frame without a full all-thread scan, but retain a bounded
      // scheduling and browser-event deadline.
      if ((completedFrames & 7) === 7 &&
          Date.now() >= this._nextEventLoopYieldAt) {
        completedFrames += 1;
        break;
      }
    }
    if (completedFrames > 0) {
      this.generatedSchedulerBurstFrames += completedFrames;
      this.generatedSchedulerBurstBatches += 1;
    }
    if (callStack.isEmpty()) {
      thread.status = "terminated";
      if (this.threads.every((candidate) =>
        candidate.status === "terminated")) return TICK_COMPLETE;
      if (this.threads.length > 0) {
        this._advanceSchedulerThread();
      }
      return TICK_CONTINUE;
    }
    if (callStack.size() > this.maxStackDepth ||
        callStack.peek().pc >= callStack.peek().instructions.length) {
      return JIT_TICK_SLOW;
    }
    if (this.threads.length > 0) {
      this._advanceSchedulerThread();
    }
    return TICK_CONTINUE;
  }

  _finishSynchronousJitTick(jitResult) {
    if (!jitResult.handled) return JIT_TICK_SLOW_AFTER_PROBE;
    if (this.threads.length > 0) {
      this._advanceSchedulerThread();
    }
    return TICK_CONTINUE;
  }

  _failSynchronousJitTick(error, thread) {
    const currentFrame = thread.callStack.peek();
    const currentInstructionItem = currentFrame && currentFrame.instructions
      ? currentFrame.instructions[currentFrame.pc]
      : null;
    const label = currentInstructionItem && currentInstructionItem.labelDef;
    const currentPc = label ? parseInt(label.substring(1, label.length - 1)) : -1;
    this.handleException(error, currentPc, thread);
    if (this.threads.length > 0) {
      this._advanceSchedulerThread();
    }
    return TICK_CONTINUE;
  }

  _tryExecuteSynchronousInterpreterTick(scheduled, skipJit = false) {
    if (scheduled.completed) return TICK_COMPLETE;
    if (scheduled.idle) return {slow: true, skipJit};
    const {thread, callStack} = scheduled;
    if (callStack.size() > this.maxStackDepth || callStack.isEmpty()) {
      return {slow: true, skipJit};
    }
    const entryFrame = callStack.peek();
    if (entryFrame.pc >= entryFrame.instructions.length ||
        entryFrame.isSynchronizedMethod && !entryFrame.monitorEntered) {
      return {slow: true, skipJit};
    }
    // This path is deliberately narrower than executeTick: it only removes the
    // Promise/microtask cost when the already prepared bytecode handlers prove
    // that the complete same-frame quantum is synchronous. Calls and returns
    // still end the quantum at exactly the existing Frame boundary.
    if (this.debugManager.debugMode || this.verbose || this._envTrace ||
        this._envProfileHot) return {slow: true, skipJit};
    prepareSyncInstructions(
      entryFrame.instructions, entryFrame.method, entryFrame.exceptionTable);

    const instructions = entryFrame.instructions;
    const inlineRegions = this.jit.inlineLoopRegionPcCache.get(
      entryFrame.method);
    let executedBytecodes = 0;
    for (let executed = 0; executed < this.interpreterBurst; executed += 1) {
      if (entryFrame.pc >= instructions.length ||
          thread.status !== "runnable") break;
      // The canonical slow path owns inline-loop OSR and its exception PC
      // reconstruction. Do not duplicate that state machine here.
      if (inlineRegions?.has(entryFrame.pc)) {
        return {slow: true, skipJit: true};
      }
      const instructionItem = instructions[entryFrame.pc];
      const instruction = instructionItem?.instruction;
      if (!instruction) {
        entryFrame.pc += 1;
        executedBytecodes += 1;
        continue;
      }
      const handler = instructionItem[syncHandler];
      if (!handler) {
        return {slow: true, skipJit: true};
      }
      entryFrame.pc += 1;
      executedBytecodes += 1;
      try {
        const handlerResult = handler(
          entryFrame,
          instructionItem[syncInstruction],
          this,
          thread,
        );
        if (handlerResult && typeof handlerResult.then === "function" ||
            handlerResult === syncFallback ||
            handlerResult === syncInvokeFallback) {
          // Async-capable handlers are uncommon after initialization. They
          // already consumed this instruction exactly as executeTick would, so
          // finish that one operation without replaying it, then yield through
          // the ordinary scheduler protocol.
          const finish = async () => {
            let resolved = handlerResult;
            if (resolved && typeof resolved.then === "function") {
              resolved = await resolved;
            }
            if (resolved === syncFallback ||
                resolved === syncInvokeFallback) {
              await dispatch(entryFrame, instruction, this, thread);
            }
            if (this.threads.length > 0) {
              this._advanceSchedulerThread();
            }
            return TICK_CONTINUE;
          };
          return finish().catch((error) =>
            this._failSynchronousInterpreterTick(
              error, thread, instructionItem));
        }
      } catch (error) {
        return this._failSynchronousInterpreterTick(
          error, thread, instructionItem);
      }
      if (callStack.items[callStack.items.length - 1] !== entryFrame ||
          thread.status !== "runnable") break;
    }
    if (this.threads.length > 0) this._advanceSchedulerThread();
    return TICK_CONTINUE;
  }

  _failSynchronousInterpreterTick(error, thread, instructionItem) {
    const label = instructionItem?.labelDef;
    const currentPc = label
      ? parseInt(label.substring(1, label.length - 1)) : -1;
    this.handleException(error, currentPc, thread);
    if (this.threads.length > 0) {
      this._advanceSchedulerThread();
    }
    return TICK_CONTINUE;
  }

  async executeTick(options = {}, scheduled = null, skipJit = false) {
    scheduled = scheduled || this._prepareSchedulerTick();
    if (scheduled.completed) return { completed: true };
    if (scheduled.idle) {
      await yieldToEventLoop(
        this._idleWaitDelay(scheduled.schedulerNow),
        this.eventLoopYieldStrategy,
      );
      return { completed: false };
    }

    const { thread, callStack } = scheduled;

    if (callStack.size() > this.maxStackDepth) {
      const guestStack = callStack.items.slice(-32).map((candidate) => {
        const method = candidate.method || {};
        return `${candidate.className || method.className || "?"}.` +
          `${method.name || "?"}${method.descriptor || ""}@${candidate.pc}`;
      });
      const error = {
        type: "java/lang/StackOverflowError",
        message: `Stack overflow (${callStack.size()} frames): ` +
          guestStack.join(" -> "),
      };
      this.handleException(error, -1, thread);
      return { completed: false };
    }

    if (callStack.isEmpty()) {
      thread.status = "terminated";
      this._advanceSchedulerThread();
      return { completed: false };
    }

    const frame = callStack.peek();
    if (frame.pc >= frame.instructions.length) {
      if (frame.jitFrameHandoffTrace) {
        console.error('[jvm-frame-handoff-fallthrough] ' + JSON.stringify({
          ...frame.jitFrameHandoffTrace,
          childPc: frame.pc,
          childInstructions: frame.instructions.length,
          childDepth: frame.stack.items.length,
        }));
      }
      const popped = callStack.pop();
      this.completeClassInitialization(popped);
      
      if (isReflectiveTarget(thread, popped)) {
        let ret = null;
        if (!popped.stack.isEmpty()) {
          ret = popped.stack.pop();
        }
        await completeReflectiveCall(thread, ret);
      }
      return { completed: false };
    }

    // Enter the implied monitor before anything executes in this frame -- the
    // JIT attempt below included. Leaving pc untouched makes the scheduler
    // retry this frame once the owner releases, exactly like monitorenter.
    if (frame.isSynchronizedMethod && !frame.monitorEntered &&
        !this.enterFrameMonitorIfNeeded(frame, thread)) {
      if (this.threads.length > 0) {
        this._advanceSchedulerThread();
      }
      return { completed: false };
    }

    try {
      // Generated JavaScript and Wasm entries normally complete
      // synchronously. Do not force a Promise/microtask round trip for those
      // hot scheduler entries; the interpreter runner still returns a Promise
      // when it genuinely reaches an asynchronous path.
      if (!skipJit) {
        let jitResult = this.jit.tryRunFrame(frame, thread);
        if (jitResult && typeof jitResult.then === "function") {
          jitResult = await jitResult;
        }
        if (jitResult.handled) {
          if (this.threads.length > 0) {
            this._advanceSchedulerThread();
          }
          return { completed: false };
        }
      }
    } catch (e) {
      const currentFrame = thread.callStack.peek();
      const currentInstructionItem = currentFrame && currentFrame.instructions
        ? currentFrame.instructions[currentFrame.pc]
        : null;
      const label = currentInstructionItem && currentInstructionItem.labelDef;
      const currentPc = label
        ? parseInt(label.substring(1, label.length - 1))
        : -1;
      this.handleException(e, currentPc, thread);
      if (this.threads.length > 0) {
        this._advanceSchedulerThread();
      }
      return { completed: false };
    }

    prepareSyncInstructions(frame.instructions, frame.method, frame.exceptionTable);

    const burstAllowed = options.allowBurst === true && !this.debugManager.debugMode &&
      !this.verbose && !this._envTrace && !this._envProfileHot;
    const instructionInstrumentation = this._envTrace || this._envProfileHot;
    const limit = burstAllowed ? this.interpreterBurst : 1;
    let executedBytecodes = 0;

    for (let executed = 0; executed < limit; executed++) {
      const currentFrame = callStack.isEmpty() ? null : callStack.peek();
      if (!currentFrame || currentFrame.pc >= currentFrame.instructions.length ||
          thread.status !== 'runnable') break;

      // An invoke earlier in this burst may have pushed a synchronized frame;
      // it must not execute before its monitor is held. This runs per bytecode,
      // so the overwhelmingly common non-synchronized case stays two property
      // reads and never reaches the call.
      if (currentFrame.isSynchronizedMethod && !currentFrame.monitorEntered &&
          !this.enterFrameMonitorIfNeeded(currentFrame, thread)) break;

      // A whole method may still be warming while a verified bounded
      // primitive-array loop inside it is already hot. Enter the cached scalar
      // region at its exact header from the interpreter quantum; no method
      // identity participates, and invalid/debuggable states retain the
      // ordinary instruction path.
      const inlineRegions = this.jit.inlineLoopRegionPcCache.get(
        currentFrame.method);
      if (inlineRegions && inlineRegions.has(currentFrame.pc)) {
        try {
          if (this.jit.tryRunInlineLoopRegionOsr(currentFrame, thread)) {
            executedBytecodes++;
            continue;
          }
        } catch (e) {
          const item = currentFrame.instructions[currentFrame.pc];
          const label = item && item.labelDef;
          const currentPc = label
            ? parseInt(label.substring(1, label.length - 1))
            : -1;
          this.handleException(e, currentPc, thread);
          break;
        }
      }

      // Never step across a debugger breakpoint inside one quantum. The
      // outer execute loop observes it immediately after this tick.
      if (executed > 0 && this.debugManager.breakpoints.size > 0) {
        const nextItem = currentFrame.instructions[currentFrame.pc];
        const nextLabel = nextItem && nextItem.labelDef;
        const nextPc = nextLabel ? parseInt(nextLabel.substring(1, nextLabel.length - 1)) : -1;
        if (this.debugManager.breakpoints.has(nextPc)) break;
      }

      const instructionItem = currentFrame.instructions[currentFrame.pc];
      const instruction = instructionItem.instruction;
      currentFrame.pc++;
      executedBytecodes++;

      try {
        if (instruction) {
          const isReturnInstruction = instruction === 'return' ||
            (instruction.op && (instruction.op === 'ireturn' || instruction.op === 'areturn'));
          const shouldSetupNextAppletMethod = isReturnInstruction &&
            this.debugManager.debugMode && thread.appletInfo &&
            thread.appletInfo.nextMethods.length > 0;

          if (shouldSetupNextAppletMethod) {
            await this.executeInstruction(instruction, currentFrame, thread);
            await this.setupNextAppletMethod(thread);
            break;
          }

          const handler = instructionItem[syncHandler];
          if (!burstAllowed || !handler) {
            if (instructionInstrumentation) {
              await this.executeInstruction(instruction, currentFrame, thread);
            } else {
              await dispatch(currentFrame, instruction, this, thread);
            }
            // Many async-capable handlers only need to await on their cold
            // path (class initialization, loading, or a Java call). Once warm,
            // getstatic/casts/native invokes complete on this same frame. Keep
            // those in the bounded quantum; the frame/status checks below
            // still stop immediately for calls, sleeps, waits, and blocking.
          } else {
            const result = handler(
              currentFrame,
              instructionItem[syncInstruction],
              this,
              thread,
            );
            let resolvedResult = result;
            if (resolvedResult && typeof resolvedResult.then === 'function') {
              resolvedResult = await resolvedResult;
            }
            if (resolvedResult === syncFallback || resolvedResult === syncInvokeFallback) {
              await dispatch(currentFrame, instruction, this, thread);
            }
          }
        }
      } catch (e) {
        const isJavaException = e && typeof e.type === "string" && e.type.includes("/");
        if (!isJavaException && this.verbose) {
          console.error(
            `>>>>>> BUG HUNT: Caught exception in executeTick for thread ${thread.id} <<<<<<`,
          );
          console.error(e);
        }
        const label = instructionItem.labelDef;
        const currentPc = label
          ? parseInt(label.substring(1, label.length - 1))
          : -1;
        this.handleException(e, currentPc, thread);
        break;
      }

      // Returns and monitor operations can change the active frame or thread
      // state even though their handlers are synchronous.
      if (callStack.isEmpty() || callStack.peek() !== currentFrame ||
          thread.status !== 'runnable') break;
    }

    if (this.threads.length > 0) {
      this._advanceSchedulerThread();
    }

    return { completed: false, bytecodes: executedBytecodes };
  }

  _idleWaitDelay(schedulerNow) {
    // Deterministic clocks advance when queried, not with wall time. Preserve
    // their fast, reproducible scheduler behavior instead of sleeping.
    if (this.clock && this.clock.enabled && !this.clock.realtime) return 0;

    let nextDeadline = Infinity;
    for (const thread of this.threads) {
      if (thread.status === 'SLEEPING' && thread.sleepUntil !== undefined) {
        nextDeadline = Math.min(nextDeadline, Number(thread.sleepUntil));
      } else if (thread.status === 'WAITING' && thread.waitDeadline !== undefined) {
        nextDeadline = Math.min(nextDeadline, Number(thread.waitDeadline));
      }
    }

    if (!Number.isFinite(nextDeadline)) return this.eventLoopYieldMs;
    const remaining = Math.ceil(nextDeadline - schedulerNow);
    return Math.max(1, Math.min(this.eventLoopYieldMs, remaining));
  }

  shouldPause(currentPc, frame) {
    return false;
  }

  shouldPauseAfterStep(currentPc, frame) {
    return false;
  }

  // Write headless software canvases (component._pixels painted by the JRE
  // Graphics fallback) as PNGs into JVM_FRAME_DIR. No-op outside Node.
  dumpSoftCanvases() {
    if (typeof process === 'undefined' || !process.env || !process.env.JVM_FRAME_DIR) return;
    if (!this._softCanvases || !this._softCanvases.size) return;
    try {
      const { encodePng } = require('../io/pngEncoder');
      fs.mkdirSync(process.env.JVM_FRAME_DIR, { recursive: true });
      let i = 0;
      for (const comp of this._softCanvases) {
        if (!comp._pixels) continue;
        const file = path.join(process.env.JVM_FRAME_DIR, `canvas-${i++}.png`);
        fs.writeFileSync(file, encodePng(comp._pixels, comp._pixelsWidth, comp._pixelsHeight));
        console.error(`soft canvas written: ${file} (${comp._pixelsWidth}x${comp._pixelsHeight})`);
      }
    } catch (e) {
      console.error(`soft canvas dump failed: ${e.message}`);
    }
  }

  async executeInstruction(instruction, frame, thread) {
    if (typeof process !== 'undefined' && process.env &&
      (process.env.JVM_PROFILE_HOT_METHODS === '1' ||
        process.env.JVM_PROFILE_HOT_METHODS_WITH_JIT === '1')) {
      const method = frame.method || {};
      const key = `${frame.className}.${method.name || '?'}${method.descriptor || ''}`;
      this._hotMethodCounts.set(key, (this._hotMethodCounts.get(key) || 0) + 1);
    }
    if (typeof process !== 'undefined' && process.env && process.env.JVM_TRACE) {
      if (!thread._trace) thread._trace = [];
      const m = frame.method || {};
      const op = typeof instruction === 'string'
        ? instruction
        : (instruction && instruction.op) || JSON.stringify(instruction).slice(0, 60);
      thread._trace.push(`${frame.className}.${m.name}${m.descriptor} pc=${frame.pc} ${op} stack=${frame.stack.size()}`);
      if (thread._trace.length > 200) thread._trace.shift();
      if (process.env.JVM_TRACE_EXIT) {
        this._traceCount = (this._traceCount || 0) + 1;
        if (this._traceCount >= Number(process.env.JVM_TRACE_EXIT)) {
          console.error(`--- JVM_TRACE_EXIT after ${this._traceCount} instructions ---`);
          for (const t of this.threads) {
            console.error(`thread ${t.id} (${t.name}) status=${t.status} frames=${t.callStack ? t.callStack.size() : '?'}`);
            const items = t.callStack && t.callStack.items ? t.callStack.items : [];
            for (let i = items.length - 1; i >= 0; i--) {
              const fm = items[i].method || {};
              console.error(`    at ${items[i].className}.${fm.name}${fm.descriptor} pc=${items[i].pc}`);
            }
            if (t._trace) console.error(t._trace.slice(-40).join('\n'));
          }
          this.dumpSoftCanvases();
          process.exit(3);
        }
      }
    }
    await dispatch(frame, instruction, this, thread);
  }

  dumpHotMethods(limit = 10) {
    const ranked = [...this._hotMethodCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(1, Number(limit) || 10));
    if (!ranked.length) return;
    console.error('--- JVM hot methods (interpreted instructions) ---');
    for (const [method, count] of ranked) console.error(`${count}\t${method}`);
  }

  loadClassByPathSync(classFilePath) {
    const classFileContent = fs.readFileSync(classFilePath);
    const rawAst = getAST(classFileContent);
    const convertedAst = convertJson(rawAst.ast, rawAst.constantPool);
    return { ast: convertedAst, constantPool: rawAst.constantPool };
  }

  async loadClassAsync(classFilePath, options = {}) {
    // Try async first, fall back to sync for backwards compatibility
    try {
      const classData = await loadClassByPath(classFilePath, options);
      if (classData) {
        classData.staticFields = new Map();
        this.classes[classData.ast.classes[0].className] = classData;
      }
      return classData;
    } catch (error) {
      // If async fails and we have a sync provider, try sync method
      try {
        const classData = loadConvertedClass(classFilePath, options);
        if (classData) {
          classData.staticFields = new Map();
          this.classes[classData.ast.classes[0].className] = classData;
        }
        return classData;
      } catch (syncError) {
        // If both fail, throw the original async error
        throw error;
      }
    }
  }

  async loadClassFromJar(jarPath, classNameWithSlashes) {
    const resolvedJarPath = path.resolve(jarPath);
    let zip = this.jarCache.get(resolvedJarPath);

    if (!zip) {
      const jarBytes = await fs.promises.readFile(resolvedJarPath);
      zip = await JSZip.loadAsync(jarBytes);
      this.jarCache.set(resolvedJarPath, zip);
    }

    const entry = zip.file(`${classNameWithSlashes}.class`);
    if (!entry) {
      return null;
    }

    const classFileContent = Buffer.from(await entry.async('uint8array'));
    const rawAst = getAST(classFileContent);
    const convertedAst = convertJson(rawAst.ast, rawAst.constantPool);
    const classData = {
      ast: convertedAst,
      constantPool: rawAst.constantPool,
      staticFields: new Map(),
    };

    this.classes[classData.ast.classes[0].className] = classData;
    return classData;
  }

  // Every class registration goes through here so world-baked compiled code
  // can be notified synchronously: speculative monomorphic wasm links read a
  // per-module "specok" flag that must drop before a receiver of the new
  // class can reach them mid-run.
  bumpClassEpoch() {
    this.classEpoch += 1;
    const wasmJit = this.jit && this.jit.wasmJit;
    if (wasmJit && wasmJit.onClassEpochBump) wasmJit.onClassEpochBump();
  }

  createArrayClass(arrayClassName) {
    // Create a synthetic array class
    const arrayClass = {
      className: arrayClassName,
      isArray: true,
      componentType: this.getArrayComponentType(arrayClassName),
      ast: {
        classes: [{
          className: arrayClassName,
          superClass: 'java/lang/Object',
          interfaces: [],
          items: [],
          flags: ['public', 'final', 'abstract']
        }]
      }
    };
    
    // Store it in the classes registry
    this.classes[arrayClassName] = arrayClass;
    this.bumpClassEpoch();
    return arrayClass;
  }

  getArrayComponentType(arrayClassName) {
    if (!arrayClassName.startsWith('[')) {
      return null;
    }
    
    const descriptor = arrayClassName.substring(1);
    
    // Handle primitive types
    if (arrayPrimitiveTypeDescriptors[descriptor]) {
      return arrayPrimitiveTypeDescriptors[descriptor];
    }
    
    // Handle object types (L<classname>;)
    if (descriptor.startsWith('L') && descriptor.endsWith(';')) {
      return descriptor.substring(1, descriptor.length - 1);
    }
    
    // Handle nested arrays
    if (descriptor.startsWith('[')) {
      return descriptor;
    }
    
    return null;
  }

  async loadClassByName(className) {
    const classNameWithSlashes = className.replace(/\./g, '/');
    const existingClass = this.classes[classNameWithSlashes];
    const isKnownJreClass = !!this.jre[classNameWithSlashes];
    const allowsApplicationFallback = isKnownJreClass &&
      this.jre[classNameWithSlashes].applicationFallback;
    if (existingClass && (!existingClass.isJreStub ||
        (isKnownJreClass && !allowsApplicationFallback))) {
      return existingClass;
    }

    // Handle array classes (e.g., [I, [[Ljava/lang/String;, etc.)
    if (classNameWithSlashes.startsWith('[')) {
      return this.createArrayClass(classNameWithSlashes);
    }

    const pendingLoad = this.classLoadPromises.get(classNameWithSlashes);
    if (pendingLoad) return pendingLoad;

    const loadPromise = (async () => {
      for (const cp of this.classpath) {
        const lowerCp = String(cp).toLowerCase();

        if (lowerCp.endsWith('.jar') || lowerCp.endsWith('.zip')) {
          const classData = await this.loadClassFromJar(cp, classNameWithSlashes);
          if (classData && classData.ast) {
            this.classes[classNameWithSlashes] = classData;
            this.bumpClassEpoch();
            this._notifyClassLoaded(classNameWithSlashes, classData);
            return classData;
          }
          continue;
        }

        const classFilePath = path.join(cp, `${classNameWithSlashes}.class`);
        try {
          const classData = await this.loadClassAsync(classFilePath);
          if (classData && classData.ast) {
            this.classes[classNameWithSlashes] = classData;
            this.bumpClassEpoch();
            this._notifyClassLoaded(classNameWithSlashes, classData);
            return classData;
          }
        } catch (error) {
          if (error.code !== 'ENOENT') {
            throw error;
          }
        }
      }

      return null;
    })();
    this.classLoadPromises.set(classNameWithSlashes, loadPromise);
    try {
      return await loadPromise;
    } finally {
      if (this.classLoadPromises.get(classNameWithSlashes) === loadPromise) {
        this.classLoadPromises.delete(classNameWithSlashes);
      }
    }
  }

  /**
   * Get or create a Class object for the given class name, maintaining object identity
   * @param {string} classNameWithSlashes - Class name with slashes (e.g., "java/lang/String")
   * @returns {Promise<Object>} The Class object
   */
  getClassObjectSync(classNameWithSlashes) {
    // Check cache first
    if (this.classObjectCache.has(classNameWithSlashes)) {
      return this.classObjectCache.get(classNameWithSlashes);
    }

    // Handle primitive types
    const primitiveTypeNames = new Set(Object.values(primitiveTypeDescriptors));

    if (primitiveTypeNames.has(classNameWithSlashes)) {
      const classObj = {
        type: "java/lang/Class",
        isPrimitive: true,
        name: classNameWithSlashes,
      };
      this.classObjectCache.set(classNameWithSlashes, classObj);
      return classObj;
    }

    // Class literals do not initialize their target, but resolving a cold
    // literal can still require asynchronous archive I/O. Generated
    // synchronous bodies use this loaded-only path and deopt before the ldc
    // when it returns null; the interpreter then performs normal loading.
    let classData = this.classes[classNameWithSlashes];
    if (!classData && this.jre[classNameWithSlashes]) {
      const jreClass = this.jre[classNameWithSlashes];
      const staticFields = jreClass.staticFields instanceof Map
        ? jreClass.staticFields
        : new Map(Object.entries(jreClass.staticFields || {}));
      const reflectedFields = Array.from(staticFields.keys()).map((rawKey) => {
        const key = String(rawKey).replace(/^'|'$/g, '');
        const separator = key.indexOf(':');
        const name = separator === -1 ? key : key.slice(0, separator);
        const descriptor = separator === -1 ? 'Ljava/lang/Object;' : key.slice(separator + 1);
        return {
          type: 'field',
          field: {
            name,
            descriptor,
            accessFlags: 0x0008,
            flags: ['static'],
          },
        };
      });
      classData = {
        isJreStub: true,
        ast: {
          classes: [{
            className: classNameWithSlashes,
            superClassName: jreClass.super || 'java/lang/Object',
            interfaces: jreClass.interfaces || [],
            flags: [],
            items: reflectedFields,
          }],
        },
        staticFields,
      };
      this.classes[classNameWithSlashes] = classData;
      this.bumpClassEpoch();
    }
    if (!classData) return null;

    const classObj = {
      type: "java/lang/Class",
      _classData: classData,
    };
    this.classObjectCache.set(classNameWithSlashes, classObj);
    return classObj;
  }

  async getClassObject(classNameWithSlashes) {
    const loaded = this.getClassObjectSync(classNameWithSlashes);
    if (loaded) return loaded;
    const classData = await this.loadClassByName(classNameWithSlashes);
    if (!classData) {
      throw { type: 'java/lang/ClassNotFoundException', message: classNameWithSlashes };
    }
    return this.getClassObjectSync(classNameWithSlashes);
  }

  async initializeClassIfNeeded(className, thread) {
    const state = className && this.classInitializationState.get(className);
    if (!className || state === "INITIALIZED") {
      return false;
    }

    if (state === "ERRONEOUS") {
      throw {
        type: "java/lang/NoClassDefFoundError",
        message: `Could not initialize class ${className}`,
      };
    }

    if (state === "INITIALIZING") {
      if (this.classInitializationOwners.get(className) === thread.id) {
        return false;
      }
      thread.status = "CLASS_INITIALIZATION_WAIT";
      thread.waitingForClassInitialization = className;
      return true;
    }

    if (this.verbose) {
      console.log(`Initializing class: ${className}`);
    }

    this._setClassInitializationState(className, "INITIALIZING");
    this.classInitializationOwners.set(className, thread.id);

    // For JRE classes, we should already have them preloaded in this.classes
    let classData = this.classes[className];
    if (classData && classData.isJreStub &&
        this.jre[className] && this.jre[className].applicationFallback) {
      classData = await this.loadClassByName(className);
    }
    if (!classData) {
      // Targeted overrides may augment an application class without replacing
      // its bytecode implementation.
      if (!this.jre[className] || this.jre[className].applicationFallback) {
        classData = await this.loadClassByName(className);
      } else {
        // JRE class should have been preloaded, something went wrong
        if (this.verbose) {
          console.warn(`JRE class ${className} not found in preloaded classes`);
        }
        this._markClassInitialized(className);
        return false;
      }
    }

    if (classData) {
      const superClassName = classData.ast.classes[0].superClassName;
      if (superClassName) {
        const wasSuperPushed = await this.initializeClassIfNeeded(
          superClassName,
          thread,
        );
        if (wasSuperPushed) {
          this.classInitializationState.delete(className);
          const token = this.classInitializationTokens.get(className);
          if (token) {
            token.state = undefined;
            token.initialized = false;
          }
          this.classInitializationOwners.delete(className);
          return true;
        }
      }

      // Initialize static fields with default values first
      if (!classData.staticFields || !classData.staticFieldsInitialized) {
        if (!classData.staticFields) {
          classData.staticFields = new Map();
        }
        classData.staticFieldsInitialized = true;

        if (this.verbose) {
          console.log(`Initializing staticFields for ${className}`);
        }

        // Initialize static fields from bytecode AST
        if (classData.ast && classData.ast.classes[0]) {
          const fields = classData.ast.classes[0].items.filter(
            (item) =>
              item.type === "field" &&
              item.field.flags &&
              item.field.flags.includes("static"),
          );

          for (const fieldItem of fields) {
            const field = fieldItem.field;
            const fieldKey = `${field.name}:${field.descriptor}`;

            classData.staticFields.set(fieldKey, staticFieldInitialValue(this, field));

            if (this.verbose) {
              console.log(
                `Initialized static field ${fieldKey} with default value`,
              );
            }
          }
        }

        // Initialize static fields from JRE definitions
        const jreClass = this.jre[className];
        if (jreClass && jreClass.staticFields) {
          if (this.verbose) {
            console.log(
              `Found JRE class ${className} with staticFields:`,
              Object.keys(jreClass.staticFields),
            );
          }
          for (const [fieldKey, fieldValue] of Object.entries(
            jreClass.staticFields,
          )) {
            // Handle Class-type static fields to ensure object identity
            if (fieldValue && fieldValue.type === 'java/lang/Class') {
              let processedFieldValue;
              if (fieldValue.isPrimitive && fieldValue.name) {
                // This is a primitive class like Integer.TYPE or Void.TYPE
                processedFieldValue = await this.getClassObject(fieldValue.name);
              } else {
                // Regular class, use as is for now (could be enhanced later)
                processedFieldValue = fieldValue;
              }
              classData.staticFields.set(fieldKey, processedFieldValue);
            } else {
              classData.staticFields.set(fieldKey, fieldValue);
            }

            if (this.verbose) {
              console.log(
                `Initialized JRE static field ${fieldKey}:`,
                fieldValue,
              );
            }
          }
        } else {
          if (this.verbose) {
            console.log(
              `No JRE class found for ${className}, or no staticFields defined`,
            );
            console.log(`JRE class exists: ${!!jreClass}`);
            if (jreClass) {
              console.log(`JRE class keys:`, Object.keys(jreClass));
            }
          }
        }
      }

      // Check for and execute native initializer
      const nativeClinit = this._jreFindMethod(className, "<clinit>", "()V");
      if (nativeClinit) {
        if (this.verbose) {
          console.log(`Executing native <clinit> for ${className}`);
        }
        nativeClinit(this, null, [], thread);

        // Log static fields after native <clinit>
        if (this.verbose && classData.staticFields) {
          console.log(
            `Static fields after <clinit> for ${className}:`,
            Array.from(classData.staticFields.keys()),
          );
        }
      }

      // Check for and execute bytecode initializer
      const staticInitializer = this.findStaticInitializer(classData);
      if (staticInitializer) {
        const clinitFrame = new Frame(staticInitializer);
        clinitFrame.className = className; // Add className to the frame
        clinitFrame.initializingClassName = className;
        thread.callStack.push(clinitFrame);
        // We pushed a bytecode initializer, so the calling instruction needs to be re-run.
        return true;
      }
    }

    this._markClassInitialized(className);
    return false;
  }

  _markClassInitialized(className) {
    this._setClassInitializationState(className, "INITIALIZED");
    this.classInitializationOwners.delete(className);
    this._wakeClassInitializationWaiters(className);
  }

  completeClassInitialization(frame) {
    const className = frame && frame.initializingClassName;
    if (!className) return;
    delete frame.initializingClassName;
    this._markClassInitialized(className);
  }

  failClassInitialization(frame) {
    const className = frame && frame.initializingClassName;
    if (!className) return;
    delete frame.initializingClassName;
    this._setClassInitializationState(className, "ERRONEOUS");
    this.classInitializationOwners.delete(className);
    this._wakeClassInitializationWaiters(className);
  }

  getClassInitializationToken(className) {
    let token = this.classInitializationTokens.get(className);
    if (!token) {
      const state = this.classInitializationState.get(className);
      token = { state, initialized: state === "INITIALIZED" };
      this.classInitializationTokens.set(className, token);
    }
    return token;
  }

  _setClassInitializationState(className, state) {
    this.classInitializationState.set(className, state);
    const token = this.classInitializationTokens.get(className);
    if (token) {
      token.state = state;
      token.initialized = state === "INITIALIZED";
    }
  }

  _refreshClassInitializationTokens() {
    for (const [className, token] of this.classInitializationTokens) {
      const state = this.classInitializationState.get(className);
      token.state = state;
      token.initialized = state === "INITIALIZED";
    }
  }

  _wakeClassInitializationWaiters(className) {
    for (const candidate of this.threads) {
      if (candidate.status === "CLASS_INITIALIZATION_WAIT" &&
          candidate.waitingForClassInitialization === className) {
        candidate.status = "runnable";
        delete candidate.waitingForClassInitialization;
      }
    }
  }

  findMainMethod(classData) {
    const mainMethod = classData.ast.classes[0].items.find((item) => {
      return (
        item.type === "method" &&
        item.method.name === "main" &&
        item.method.descriptor === "([Ljava/lang/String;)V"
      );
    });
    return mainMethod ? mainMethod.method : null;
  }

  isAppletClass(classData) {
    // Check if this class extends java/applet/Applet
    let currentClassName = classData.ast.classes[0].className;
    let currentClassData = classData;

    while (currentClassData) {
      const superClassName = currentClassData.ast.classes[0].superClassName;
      if (superClassName === 'java/applet/Applet') {
        return true;
      }
      if (!superClassName || superClassName === 'java/lang/Object') {
        return false;
      }
      currentClassData = this.classes[superClassName];
    }
    return false;
  }

  async isAppletClassAsync(classData) {
    // Like isAppletClass, but loads not-yet-loaded superclasses from the
    // classpath so applets behind an intermediate superclass are detected.
    let currentClassData = classData;

    while (currentClassData && currentClassData.ast) {
      const superClassName = currentClassData.ast.classes[0].superClassName;
      if (superClassName === 'java/applet/Applet') {
        return true;
      }
      if (!superClassName || superClassName === 'java/lang/Object') {
        return false;
      }
      currentClassData = this.classes[superClassName] ||
        await this.loadClassByName(superClassName).catch(() => null);
    }
    return false;
  }

  findStaticInitializer(classData) {
    const clinitMethod = classData.ast.classes[0].items.find((item) => {
      const codeAttr = item.method && item.method.attributes &&
        item.method.attributes.find((attr) => attr.type === "code" && attr.code);
      return (
        item.type === "method" &&
        item.method.name === "<clinit>" &&
        item.method.descriptor === "()V" &&
        codeAttr &&
        Array.isArray(codeAttr.code.codeItems)
      );
    });
    return clinitMethod ? clinitMethod.method : null;
  }

  findMethod(classData, methodName, descriptor) {
    if (this.verbose) {
      console.log(`findMethod: Searching for ${methodName}${descriptor}`);
      console.log(`findMethod: In class ${classData.ast.classes[0].className}`);
      console.log(
        `findMethod: Total items: ${classData.ast.classes[0].items.length}`,
      );
    }

    const method = classData.ast.classes[0].items.find((item) => {
      if (this.verbose) {
        console.log(`findMethod: Checking item:`, item.type);
      }

      // Extract primitive string value if methodName is a String object
      const methodNameStr =
        typeof methodName === "object" && methodName.type === "java/lang/String"
          ? methodName.valueOf()
          : methodName;

      const isMatch =
        item.type === "method" &&
        item.method.name === methodNameStr &&
        item.method.descriptor === descriptor;

      if (this.verbose && item.type === "method") {
        console.log(
          `findMethod: Comparing '${item.method.name}' with '${methodNameStr}' (original: '${methodName}')`,
        );
        console.log(
          `findMethod: Name equality: ${item.method.name === methodNameStr}`,
        );
        console.log(
          `findMethod: Name lengths: ${item.method.name.length} vs ${methodNameStr.length}`,
        );
        console.log(
          `findMethod: Name char codes: ${Array.from(item.method.name).map((c) => c.charCodeAt(0))} vs ${Array.from(methodNameStr).map((c) => c.charCodeAt(0))}`,
        );
        console.log(
          `findMethod: Name JSON: ${JSON.stringify(item.method.name)} vs ${JSON.stringify(methodNameStr)}`,
        );
        console.log(
          `findMethod: Name hex: ${Array.from(item.method.name).map((c) => c.charCodeAt(0).toString(16))} vs ${Array.from(methodNameStr).map((c) => c.charCodeAt(0).toString(16))}`,
        );
        console.log(
          `findMethod: Name type: ${typeof item.method.name} vs ${typeof methodNameStr}`,
        );
      }

      if (this.verbose && item.type === "method") {
        console.log(
          `findMethod: Method ${item.method.name}${item.method.descriptor}`,
        );
        if (item.method.name === methodNameStr) {
          if (isMatch) {
            console.log(
              `findMethod: ✓ Found exact match: ${item.method.name}${item.method.descriptor}`,
            );
            console.log(
              `findMethod: Comparison details - name: ${item.method.name === methodName}, descriptor: ${item.method.descriptor === descriptor}`,
            );
          } else {
            console.log(
              `findMethod: ✗ Mismatch - expected '${descriptor}', found '${item.method.descriptor}'`,
            );
            console.log(
              `findMethod: Expected length ${descriptor.length}, found length ${item.method.descriptor.length}`,
            );
            console.log(
              `findMethod: Expected chars: ${Array.from(descriptor).map((c) => c.charCodeAt(0))}`,
            );
            console.log(
              `findMethod: Found chars: ${Array.from(item.method.descriptor).map((c) => c.charCodeAt(0))}`,
            );
            console.log(
              `findMethod: String equality: ${descriptor === item.method.descriptor}`,
            );
            console.log(
              `findMethod: Name equality: ${item.method.name === methodNameStr}`,
            );
            console.log(
              `findMethod: Name JSON equality: ${JSON.stringify(item.method.name) === JSON.stringify(methodNameStr)}`,
            );
          }
        }
      }

      return isMatch;
    });

    if (!method && this.verbose) {
      console.log(
        `findMethod: ❌ Method not found: ${methodName}${descriptor}`,
      );

      // List all method items
      const methodItems = classData.ast.classes[0].items.filter(
        (item) => item.type === "method",
      );
      console.log(`findMethod: Total method items: ${methodItems.length}`);

      methodItems.forEach((item, index) => {
        console.log(
          `findMethod: [${index}] ${item.method.name}${item.method.descriptor}`,
        );
      });

      const allMethods = methodItems.map(
        (item) => `${item.method.name}${item.method.descriptor}`,
      );
      console.log(`findMethod: Available methods: ${allMethods.join(", ")}`);

      // Check if method exists with different descriptor
      const methodsWithSameName = methodItems.filter((item) => {
        const nameMatch = item.method.name === methodName;
        if (this.verbose) {
          console.log(
            `findMethod: Filtering '${item.method.name}' vs '${methodName}': ${nameMatch}`,
          );
        }
        return nameMatch;
      });
      if (methodsWithSameName.length > 0) {
        console.log(`findMethod: Methods with name '${methodName}':`);
        methodsWithSameName.forEach((m) => {
          console.log(
            `  - ${m.method.descriptor} (length: ${m.method.descriptor.length})`,
          );
          console.log(
            `    Descriptor match: ${m.method.descriptor === descriptor}`,
          );
        });
      } else {
        console.log(`findMethod: No methods found with name '${methodName}'`);
      }
    }

    return method ? method.method : null;
  }

  async findMethodInHierarchy(className, methodName, descriptor) {
    let currentClassName = className;
    while (currentClassName) {
      let classData = this.classes[currentClassName];
      if (!classData) {
        classData = await this.loadClassByName(currentClassName);
        if (!classData) {
          return null;
        }
      }

      const method = this.findMethod(classData, methodName, descriptor);
      if (method) {
        return method;
      }

      currentClassName = classData.ast.classes[0].superClassName;
    }
    return null;
  }

  isInstanceOf(className, target) {
    if (!className) return false;
    if (className === target) return true;
    if (target && !target.includes('/') && typeof className === 'string' && className.endsWith(`/${target}`)) return true;
    if (target === "java/lang/Object" && className !== null) return true;

    if (className.startsWith && className.startsWith('[')) {
      if (target === 'java/lang/Object' ||
          target === 'java/lang/Cloneable' ||
          target === 'java/io/Serializable') return true;
      const sourceComponent = arrayComponentType(className);
      const targetComponent = arrayComponentType(target);
      if (!sourceComponent || !targetComponent) return false;
      if (sourceComponent.primitive || targetComponent.primitive) {
        return sourceComponent.primitive && targetComponent.primitive &&
          sourceComponent.name === targetComponent.name;
      }
      return this.isInstanceOf(sourceComponent.name, targetComponent.name);
    }

    const classData = this.classes[className];
    if (classData && classData.ast && classData.ast.classes && classData.ast.classes[0]) {
      const cls = classData.ast.classes[0];
      if (this.isInstanceOf(cls.superClassName, target)) return true;
      for (const iface of cls.interfaces || []) if (this.isInstanceOf(iface, target)) return true;
      return false;
    }

    const jreClass = this.jre[className];
    if (jreClass) {
      const superName = typeof jreClass.super === "string"
        ? jreClass.super
        : (jreClass.super && jreClass.super.type) || null;
      if (this.isInstanceOf(superName, target)) return true;
      for (const iface of jreClass.interfaces || []) if (this.isInstanceOf(iface, target)) return true;
      return false;
    }

    return false;
  }

  // Loading-free assignability with an explicit "unknown" result. Generated
  // code must not turn an unloaded array component (or an incomplete loaded
  // hierarchy) into a definitive ClassCastException; it deoptimizes so the
  // asynchronous resolver can load the missing classes first.
  isInstanceOfSync(className, target, seen = new Set()) {
    if (!className) return false;
    if (className === target) return true;
    if (target && !target.includes('/') && typeof className === 'string' &&
        className.endsWith(`/${target}`)) return true;
    if (target === "java/lang/Object" && className !== null) return true;

    const visitKey = `${className}->${target}`;
    if (seen.has(visitKey)) return false;
    seen.add(visitKey);

    if (className.startsWith && className.startsWith('[')) {
      if (target === 'java/lang/Object' ||
          target === 'java/lang/Cloneable' ||
          target === 'java/io/Serializable') return true;
      const sourceComponent = arrayComponentType(className);
      const targetComponent = arrayComponentType(target);
      if (!sourceComponent || !targetComponent) return false;
      if (sourceComponent.primitive || targetComponent.primitive) {
        return sourceComponent.primitive && targetComponent.primitive &&
          sourceComponent.name === targetComponent.name;
      }
      return this.isInstanceOfSync(sourceComponent.name, targetComponent.name, seen);
    }

    const classData = this.classes[className];
    if (classData && classData.ast && classData.ast.classes && classData.ast.classes[0]) {
      const cls = classData.ast.classes[0];
      let unknown = false;
      const superResult = this.isInstanceOfSync(cls.superClassName, target, seen);
      if (superResult === true) return true;
      if (superResult === null) unknown = true;
      for (const iface of cls.interfaces || []) {
        const interfaceResult = this.isInstanceOfSync(iface, target, seen);
        if (interfaceResult === true) return true;
        if (interfaceResult === null) unknown = true;
      }
      return unknown ? null : false;
    }

    const jreClass = this.jre[className];
    if (jreClass) {
      const superName = typeof jreClass.super === "string"
        ? jreClass.super
        : (jreClass.super && jreClass.super.type) || null;
      let unknown = false;
      const superResult = this.isInstanceOfSync(superName, target, seen);
      if (superResult === true) return true;
      if (superResult === null) unknown = true;
      for (const iface of jreClass.interfaces || []) {
        const interfaceResult = this.isInstanceOfSync(iface, target, seen);
        if (interfaceResult === true) return true;
        if (interfaceResult === null) unknown = true;
      }
      return unknown ? null : false;
    }

    return null;
  }

  async isInstanceOfAsync(className, target, seen = new Set()) {
    if (!className) return false;
    if (className === target) return true;
    if (target && !target.includes('/') && typeof className === 'string' && className.endsWith(`/${target}`)) return true;
    if (target === "java/lang/Object" && className !== null) return true;

    const visitKey = `${className}->${target}`;
    if (seen.has(visitKey)) return false;
    seen.add(visitKey);

    if (className.startsWith && className.startsWith('[')) {
      if (target === 'java/lang/Object' ||
          target === 'java/lang/Cloneable' ||
          target === 'java/io/Serializable') return true;
      const sourceComponent = arrayComponentType(className);
      const targetComponent = arrayComponentType(target);
      if (!sourceComponent || !targetComponent) return false;
      if (sourceComponent.primitive || targetComponent.primitive) {
        return sourceComponent.primitive && targetComponent.primitive &&
          sourceComponent.name === targetComponent.name;
      }
      return this.isInstanceOfAsync(sourceComponent.name, targetComponent.name, seen);
    }

    let classData = this.classes[className];
    if (!classData && !this.jre[className]) {
      try {
        classData = await this.loadClassByName(className);
      } catch (e) {
        classData = null;
      }
    }
    if (classData && classData.ast && classData.ast.classes && classData.ast.classes[0]) {
      const cls = classData.ast.classes[0];
      if (await this.isInstanceOfAsync(cls.superClassName, target, seen)) return true;
      for (const iface of cls.interfaces || []) if (await this.isInstanceOfAsync(iface, target, seen)) return true;
      return false;
    }

    const jreClass = this.jre[className];
    if (jreClass) {
      const superName = typeof jreClass.super === "string"
        ? jreClass.super
        : (jreClass.super && jreClass.super.type) || null;
      if (await this.isInstanceOfAsync(superName, target, seen)) return true;
      for (const iface of jreClass.interfaces || []) if (await this.isInstanceOfAsync(iface, target, seen)) return true;
      return false;
    }

    return false;
  }

  handleException(exception, pc, thread) {
    // Host exceptions retain their JavaScript stack, but normal JVM unwinding
    // removes guest frames before BrowserJVMDebug can report them. Attach the
    // deepest guest location once, on the exceptional path only, so failures
    // such as an accidental BigInt/Number coercion identify the generated
    // method and bytecode PC that caused them.
    if (exception instanceof Error && !exception.jvmGuestLocation) {
      const failingFrame = thread.callStack.isEmpty()
        ? null : thread.callStack.peek();
      if (failingFrame) {
        const failingMethod = failingFrame.method || {};
        exception.jvmGuestLocation = {
          className: failingFrame.className || null,
          methodName: failingMethod.name || null,
          descriptor: failingMethod.descriptor || null,
          pc: Number.isInteger(pc) && pc >= 0 ? pc : failingFrame.pc,
        };
      }
    }
    if (this._envDebugThrow ||
        this._envDebugThrowType && exception &&
          exception.type === this._envDebugThrowType) {
      const top = thread.callStack.isEmpty() ? null : thread.callStack.peek();
      const m = top && top.method ? top.method : {};
      const scalar = (value) => {
        if (value === null || value === undefined) return value;
        if (typeof value === "bigint") return `${value}n`;
        if (typeof value !== "object") return value;
        if (Array.isArray(value) || ArrayBuffer.isView(value)) return `[${value.length}]`;
        if (typeof value.type !== "string") return "<object>";
        const summary = { type: value.type };
        if (value.type === "java/lang/String") {
          if (Object.prototype.hasOwnProperty.call(value, "value")) {
            summary.value = String(value.value);
          } else if (value instanceof String) {
            summary.value = String(value);
          }
        }
        if (value.type === "java/lang/Class" && value.className) {
          summary.className = value.className;
        }
        const fields = value.fields;
        if (fields && typeof fields === "object") {
          summary.fields = {};
          for (const [name, fieldValue] of Object.entries(fields).slice(0, 24)) {
            if (fieldValue === null || fieldValue === undefined ||
                typeof fieldValue === "number" || typeof fieldValue === "boolean" ||
                typeof fieldValue === "string") {
              summary.fields[name] = fieldValue;
            } else if (typeof fieldValue === "bigint") {
              summary.fields[name] = `${fieldValue}n`;
            } else if (Array.isArray(fieldValue) || ArrayBuffer.isView(fieldValue)) {
              summary.fields[name] = `[${fieldValue.length}]`;
            } else if (fieldValue && fieldValue.type === "java/lang/String" &&
                       (fieldValue instanceof String ||
                        Object.prototype.hasOwnProperty.call(fieldValue, "value"))) {
              summary.fields[name] = String(
                Object.prototype.hasOwnProperty.call(fieldValue, "value")
                  ? fieldValue.value
                  : fieldValue,
              );
            } else {
              let nestedName = null;
              if (fieldValue && fieldValue.fields) {
                const namedField = Object.entries(fieldValue.fields).find(([fieldName]) =>
                  fieldName.endsWith(".name"));
                const namedValue = namedField && namedField[1];
                if (namedValue && namedValue.type === "java/lang/String" &&
                    (namedValue instanceof String ||
                     Object.prototype.hasOwnProperty.call(namedValue, "value"))) {
                  nestedName = String(
                    Object.prototype.hasOwnProperty.call(namedValue, "value")
                      ? namedValue.value
                      : namedValue,
                  );
                }
              }
              summary.fields[name] =
                `<${fieldValue.type || "object"}${nestedName ? ` name=${nestedName}` : ""}>`;
            }
          }
        }
        return summary;
      };
      console.error(`[throw] ${exception && exception.type} msg=${exception && exception.message} ` +
        `at ${top ? top.className : '?'}.${m.name || '?'}${m.descriptor || ''} ` +
        `pc=${top ? top.pc : '?'} thread=${thread.id} ` +
        `locals=${JSON.stringify(top && top.locals ? top.locals.map(scalar) : [])} ` +
        `frames=${JSON.stringify((thread.callStack.items || []).slice(-5).reverse().map((item) => ({
          method: `${item.className || "?"}.${item.method && item.method.name || "?"}` +
            `${item.method && item.method.descriptor || ""}`,
          pc: item.pc,
          locals: (item.locals || []).map(scalar),
        })))}`);
    }
    if (thread.pendingException) {
      delete thread.pendingException;
    }
    const callStack = thread.callStack;
    if (callStack.isEmpty()) {
      console.error("Unhandled exception:", exception);
      throw exception;
    }
    const frame = callStack.peek();

    let pcToCheck = pc;
    if (pc === -1) {
      const callerInstructionIndex = frame.pc - 1;
      if (callerInstructionIndex >= 0) {
        const instructionItem = frame.instructions[callerInstructionIndex];
        const label = instructionItem.labelDef;
        pcToCheck = label ? parseInt(label.substring(1, label.length - 1)) : -1;
      }
    }

    if (this.dispatchExceptionInFrame(frame, exception, pcToCheck)) return;

    this.failClassInitialization(frame);
    callStack.pop();
    this.handleException(exception, -1, thread);
  }

  // Search ONE frame's exception table for a handler covering pcToCheck and,
  // on a match, position the frame at the handler with [exception] as its
  // operand stack. Returns true when dispatched. Shared by the interpreter's
  // unwinding above and the wasm tiers' nested EH-callee links (a nested -3
  // dispatches inside the callee's scratch frame before it is materialized).
  // The object a synchronized method locks: the receiver for instance methods,
  // the declaring class's Class object for static ones -- the same object
  // `synchronized (Foo.class)` would lock, so the two forms exclude each other.
  frameMonitorObject(frame) {
    if (frame.monitorObject) return frame.monitorObject;
    // Memoised: this runs on every synchronized call, and a raw flags.includes()
    // here was an array scan per acquisition.
    const method = frame.method;
    let isStatic = method && method[FRAME_STATIC_KIND];
    if (isStatic === undefined) {
      isStatic = ((method && method.flags) || []).includes("static");
      if (method) method[FRAME_STATIC_KIND] = isStatic;
    }
    const target = isStatic
      ? (frame.className ? this.getClassObjectSync(frame.className) : null)
      : frame.locals[0];
    if (!target || typeof target !== "object") return null;
    frame.monitorObject = target;
    return target;
  }

  /**
   * Enter a synchronized method's implied monitor before its first instruction.
   * Returns false when the monitor is owned by another thread; the caller must
   * leave the frame at its current pc so the entry is retried once the
   * scheduler marks the thread runnable again (same protocol as monitorenter).
   */
  enterFrameMonitorIfNeeded(frame, thread) {
    if (!frame.isSynchronizedMethod || frame.monitorEntered) return true;
    const monitor = this.frameMonitorObject(frame);
    // A missing monitor (no receiver, unloaded class) must not wedge the
    // thread; running unsynchronized matches the previous behaviour. It still
    // counts: the flag is set, so the release path must be allowed to clear it.
    // Skipping the count here left monitorEntered stuck true on a pooled frame,
    // which then skipped acquisition entirely on its next use.
    if (!monitor) {
      frame.monitorEntered = true;
      return true;
    }
    if (!monitor.isLocked) {
      monitor.isLocked = true;
      monitor.lockOwner = thread.id;
      monitor.lockCount = 1;
    } else if (monitor.lockOwner === thread.id) {
      monitor.lockCount++;
    } else {
      thread.status = "BLOCKED";
      thread.blockingOn = monitor;
      return false;
    }
    frame.monitorEntered = true;
    frame.monitorOwnerThreadId = thread.id;
    return true;
  }

  /**
   * Release a synchronized frame's monitor. Ordinary returns and unwinds do not
   * need this: CallStack.pop() releases whatever the retiring frame held, which
   * is what lets the generated tiers return without any monitor bookkeeping.
   */
  exitFrameMonitor(frame) {
    if (!frame || !frame.monitorEntered) return;
    releaseFrameMonitor(frame);
  }

  dispatchExceptionInFrame(frame, exception, pcToCheck) {
    const table = frame.exceptionTable;
    if (!table) return false;
    for (const entry of table) {
      if (pcToCheck >= entry.start_pc && pcToCheck < entry.end_pc) {
        if (entry.catch_type === "any" ||
            this.isInstanceOf(exception.type, entry.catch_type)) {
          const targetIndex = frame.instructions.findIndex((inst) => {
            if (!inst || !inst.labelDef) return false;
            const labelPc = parseInt(
              inst.labelDef.substring(1, inst.labelDef.length - 1),
            );
            return labelPc === entry.handler_pc;
          });

          if (targetIndex !== -1) {
            frame.stack.clear();
            frame.stack.push(exception);
            frame.pc = targetIndex;
            return true;
          }
        }
      }
    }
    return false;
  }

  serialize() {
    const serialized = {
      threads: this.threads.map((thread) => ({
        id: thread.id,
        status: thread.status,
        callStack: thread.callStack.items.map((frame) => ({
          pc: frame.pc,
          locals: frame.locals,
          stack: frame.stack.items,
          method: {
            name: frame.method.name,
            descriptor: frame.method.descriptor,
            className: this.findClassNameForMethod(frame.method),
          },
        })),
      })),
      currentThreadIndex: this.currentThreadIndex,
      classInitializationState: [...this.classInitializationState],
      nextHashCode: this.nextHashCode,
      debugManager: this.debugManager.serialize(),
      classpath: this.classpath,
    };
    return JSON.parse(JSON.stringify(serialized));
  }

  saveState() {
    const savedAt = this.clock.millis();
    const threadTokens = this.threads.map((thread) => ({ $jvmThreadId: thread.id }));
    const threadReplacements = new Map(this.threads.map((thread, index) =>
      [thread, threadTokens[index]]));
    const threadSnapshots = this.threads.map((thread) => {
      const properties = {};
      for (const [key, value] of Object.entries(thread)) {
        if (key === 'callStack' || key === 'joiningOn' || key === 'sleepUntil' ||
          key === 'waitDeadline') continue;
        properties[key] = value;
      }
      if (thread.sleepUntil !== undefined) {
        properties.sleepRemaining = Math.max(0, Number(thread.sleepUntil) - savedAt);
      }
      if (thread.waitDeadline !== undefined) {
        properties.waitRemaining = Math.max(0, Number(thread.waitDeadline) - savedAt);
      }
      return {
        properties,
        joiningOnId: thread.joiningOn ? thread.joiningOn.id : null,
        frames: thread.callStack.items.map((frame) => ({
          pc: frame.pc,
          className: frame.className || this.findClassNameForMethod(frame.method),
          methodName: frame.method.name,
          descriptor: frame.method.descriptor,
          initializingClassName: frame.initializingClassName || null,
          locals: frame.locals,
          stack: frame.stack.items,
        })),
      };
    });
    const classStatics = Object.entries(this.classes)
      .filter(([, classData]) => classData && classData.staticFields !== undefined)
      .map(([className, classData]) => [className, classData.staticFields]);
    const graph = encodeGraph({
      threads: threadSnapshots,
      classStatics,
      stringPool: this.stringPool || new Map(),
      classObjectCache: this.classObjectCache,
      invokedynamicCache: this.invokedynamicCache,
    }, { replacements: threadReplacements });
    return {
      format: 'jvmjs-save-state',
      version: 1,
      savedAt,
      clock: this.clock.snapshot(),
      classpath: this.classpath,
      loadedClasses: Object.keys(this.classes),
      classInitializationState: [...this.classInitializationState],
      currentThreadIndex: this.currentThreadIndex,
      nextHashCode: this.nextHashCode,
      appletParameters: this.appletParameters,
      appletCodeBase: this.appletCodeBase,
      debugManager: this.debugManager.serialize(),
      graph,
      externalResources: graph.omitted,
    };
  }

  async loadState(state) {
    if (!state || state.format !== 'jvmjs-save-state' || state.version !== 1) {
      throw new Error('Unsupported JVM save-state format');
    }
    this.classpath = Array.isArray(state.classpath) ? state.classpath : [state.classpath || '.'];
    if (state.clock) this.clock.restore(state.clock);
    this.appletParameters = state.appletParameters || null;
    this.appletCodeBase = state.appletCodeBase || null;
    for (const className of state.loadedClasses || []) {
      await this.loadClassByName(className);
    }

    const decoded = decodeGraph(state.graph);
    for (const [className, staticFields] of decoded.classStatics || []) {
      const classData = this.classes[className] || await this.loadClassByName(className);
      if (classData) {
        classData.staticFields = staticFields;
        classData.staticFieldsInitialized = true;
      }
    }
    this.stringPool = decoded.stringPool || new Map();
    this.classObjectCache = decoded.classObjectCache || new Map();
    for (const [className, classObject] of this.classObjectCache) {
      if (classObject && typeof classObject === 'object') classObject._classData = this.classes[className];
    }
    this.invokedynamicCache = decoded.invokedynamicCache || new Map();
    await this._rehydrateSaveStateResources(decoded);

    const restoredAt = this.clock.millis();
    this.threads = [];
    for (const snapshot of decoded.threads || []) {
      const properties = snapshot.properties || {};
      const thread = { ...properties, callStack: new CallStack() };
      if (properties.sleepRemaining !== undefined) {
        thread.sleepUntil = restoredAt + Number(properties.sleepRemaining);
        delete thread.sleepRemaining;
      }
      if (properties.waitRemaining !== undefined) {
        thread.waitDeadline = restoredAt + Number(properties.waitRemaining);
        delete thread.waitRemaining;
      }
      for (const frameState of snapshot.frames || []) {
        const method = await this.findMethodInHierarchy(
          frameState.className, frameState.methodName, frameState.descriptor);
        if (!method) {
          throw new Error(`Could not restore ${frameState.className}.${frameState.methodName}${frameState.descriptor}`);
        }
        const frame = new Frame(method);
        frame.className = frameState.className;
        frame.pc = frameState.pc;
        if (frameState.initializingClassName) {
          frame.initializingClassName = frameState.initializingClassName;
        }
        frame.locals = frameState.locals;
        frame.stack.items = frameState.stack;
        thread.callStack.push(frame);
      }
      this.threads.push(thread);
    }
    (decoded.threads || []).forEach((snapshot, index) => {
      const thread = this.threads[index];
      if (snapshot.joiningOnId !== null && snapshot.joiningOnId !== undefined) {
        thread.joiningOn = this.threads.find((candidate) => candidate.id === snapshot.joiningOnId);
      }
      if (thread.javaThread && typeof thread.javaThread === 'object') {
        thread.javaThread.nativeThread = thread;
      }
    });
    this._restoreSaveStateThreadRefs(decoded);
    this.currentThreadIndex = Math.min(state.currentThreadIndex || 0,
      Math.max(0, this.threads.length - 1));
    this.classInitializationState = new ClassInitializationStateMap(
      this, state.classInitializationState || []);
    this._refreshClassInitializationTokens();
    this.classInitializationOwners = new Map();
    for (const thread of this.threads) {
      for (const frame of thread.callStack.items) {
        if (frame.initializingClassName) {
          this.classInitializationOwners.set(frame.initializingClassName, thread.id);
        }
      }
    }
    this.nextHashCode = state.nextHashCode || 1;
    if (state.debugManager) this.debugManager.deserialize(state.debugManager);
    this._nextEventLoopYieldAt = Date.now() + this.eventLoopYieldMs;
    this._hotMethodCounts = new Map();
    // Generated JS/Wasm code is deliberately not persisted. Rebuilding it
    // keeps save files portable across engines and avoids stale heap bindings.
    this.jit = new JitCompiler(this, this.jitOptions);
    return {
      status: 'restored',
      externalResources: state.externalResources || [],
    };
  }

  // Node 26 raises ERR_INVALID_STATE when a FileHandle is closed by garbage
  // collection; harnesses that restore several save states in one process
  // must close rehydrated handles before dropping the JVM.
  async closeSaveStateFileHandles() {
    const handles = this._saveStateFileHandles || [];
    this._saveStateFileHandles = [];
    for (const handle of handles) {
      try { await handle.close(); } catch (_ignored) { /* already closed */ }
    }
  }

  async _rehydrateSaveStateResources(root) {
    const seen = new WeakSet();
    const pending = [root];
    while (pending.length) {
      const value = pending.pop();
      if (!value || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);
      if (value.type === 'java/io/RandomAccessFile' && value.path && !value.fileHandle && this.fs) {
        const mode = String(value.mode || 'r');
        const writable = mode.includes('w');
        try {
          value.fileHandle = await this.fs.promises.open(value.path, writable ? 'r+' : 'r');
        } catch (error) {
          if (writable && error && error.code === 'ENOENT') {
            try { value.fileHandle = await this.fs.promises.open(value.path, 'w+'); } catch (_ignored) {}
          }
        }
        if (value.fileHandle) (this._saveStateFileHandles ||= []).push(value.fileHandle);
      }
      if (value.type === 'java/io/ConsoleOutputStream' && !value.writer &&
        typeof process !== 'undefined' && process.stdout) {
        value.writer = process.stdout.write.bind(process.stdout);
      }
      if (value instanceof Map) {
        for (const [key, item] of value) pending.push(key, item);
      } else if (value instanceof Set) {
        for (const item of value) pending.push(item);
      } else if (ArrayBuffer.isView(value)) {
        continue;
      } else {
        for (const item of Object.values(value)) {
          if (item && typeof item === 'object') pending.push(item);
        }
      }
    }
    const systemClass = this.classes['java/lang/System'];
    if (systemClass && systemClass.staticFields instanceof Map && typeof process !== 'undefined') {
      const out = systemClass.staticFields.get('out:Ljava/io/PrintStream;');
      const err = systemClass.staticFields.get('err:Ljava/io/PrintStream;');
      if (out && out.out && process.stdout) out.out.writer = process.stdout.write.bind(process.stdout);
      if (err && err.out && process.stderr) err.out.writer = process.stderr.write.bind(process.stderr);
    }
  }

  _restoreSaveStateThreadRefs(root) {
    const seen = new WeakSet();
    const resolve = (value) => {
      if (!value || typeof value !== 'object') return value;
      if (Object.prototype.hasOwnProperty.call(value, '$jvmThreadId')) {
        return this.threads.find((thread) => thread.id === value.$jvmThreadId) || null;
      }
      if (seen.has(value)) return value;
      seen.add(value);
      if (value instanceof Map) {
        const entries = [...value.entries()];
        value.clear();
        for (const [key, item] of entries) value.set(resolve(key), resolve(item));
      } else if (value instanceof Set) {
        const items = [...value];
        value.clear();
        for (const item of items) value.add(resolve(item));
      } else if (ArrayBuffer.isView(value)) {
        return value;
      } else if (value instanceof String) {
        // Boxed strings expose enumerable, read-only character indices and
        // cannot contain decoded thread placeholders.
        return value;
      } else {
        for (const key of Object.keys(value)) value[key] = resolve(value[key]);
      }
      return value;
    };
    resolve(root);
  }

  async deserialize(state) {
    if (state.classpath) {
      this.classpath = state.classpath;
    }
    this.threads = await Promise.all(
      state.threads.map(async (threadState) => {
        const thread = {
          id: threadState.id,
          status: threadState.status,
          callStack: new CallStack(),
        };
        for (const frameState of threadState.callStack) {
          const method = await this.findMethodInHierarchy(
            frameState.method.className,
            frameState.method.name,
            frameState.method.descriptor,
          );
          if (!method) {
            throw new Error(
              `Could not find method ${frameState.method.className}.${frameState.method.name}${frameState.method.descriptor} during deserialization.`,
            );
          }
          const frame = new Frame(method);
          frame.className = frameState.method.className; // Add className to the frame
          frame.pc = frameState.pc;
          frame.locals = frameState.locals;
          frame.stack.items = frameState.stack;
          thread.callStack.push(frame);
        }
        return thread;
      }),
    );
    this.currentThreadIndex = state.currentThreadIndex;
    this.classInitializationState = new ClassInitializationStateMap(
      this, state.classInitializationState);
    this._refreshClassInitializationTokens();
    this.nextHashCode = state.nextHashCode;
    if (state.debugManager) {
      this.debugManager.deserialize(state.debugManager);
    }
  }

  findClassNameForMethod(method) {
    const cached = method && this._methodClassNames.get(method);
    if (cached) return cached;
    for (const [className, classData] of Object.entries(this.classes)) {
      if (!classData?.ast?.classes?.[0]) continue;
      if (this._indexedMethodClassData.get(className) !== classData) {
        for (const item of classData.ast.classes[0].items || []) {
          if (item.type === "method" && item.method) {
            this._methodClassNames.set(item.method, className);
          }
        }
        this._indexedMethodClassData.set(className, classData);
      }
      const indexed = method && this._methodClassNames.get(method);
      if (indexed) return indexed;
    }
    return null;
  }

  findMethodByRef(methodRef) {
    const classData = this.classes[methodRef.className];
    if (!classData || !classData.ast || !classData.ast.classes[0]) {
      return null;
    }

    const methodItem = classData.ast.classes[0].items.find((item) => {
      return (
        item.type === "method" &&
        item.method.name === methodRef.methodName &&
        item.method.descriptor === methodRef.methodDescriptor
      );
    });

    return methodItem ? methodItem.method : null;
  }

  enableDebugMode() {
    this.debugManager.enable();
  }
  disableDebugMode() {
    this.debugManager.disable();
  }
  /**
   * Observe lazy class loading.  A debugger needs this to arm a breakpoint on
   * a class that has not been reached yet: the location cannot be resolved
   * until the class exists, and by the time it is running it is too late.
   */
  onClassLoaded(listener) {
    if (typeof listener !== 'function') return () => {};
    if (!this._classLoadListeners) this._classLoadListeners = [];
    this._classLoadListeners.push(listener);
    return () => {
      this._classLoadListeners =
        this._classLoadListeners.filter((entry) => entry !== listener);
    };
  }

  _notifyClassLoaded(className, classData) {
    if (!this._classLoadListeners || !this._classLoadListeners.length) return;
    for (const listener of [...this._classLoadListeners]) {
      try {
        listener(className, classData);
      } catch (error) {
        // A misbehaving observer must never break class loading.
        if (this.verbose) {
          console.error(`class-load listener failed: ${error.message}`);
        }
      }
    }
  }

  addBreakpoint(pc) {
    this.debugManager.addBreakpoint(pc, this.getCurrentBreakpointLocation());
  }

  /** Breakpoint bound to a specific class/method rather than a bare offset. */
  addLocatedBreakpoint(pc, location) {
    return this.debugManager.addStrictBreakpoint(pc, location);
  }
  removeBreakpoint(pc) {
    this.debugManager.removeBreakpoint(pc, this.getCurrentBreakpointLocation());
  }
  clearBreakpoints() {
    this.debugManager.clearBreakpoints();
  }

  getCurrentBreakpointLocation() {
    const thread = this.threads[this.currentThreadIndex];
    if (!thread || thread.callStack.isEmpty()) {
      return null;
    }
    const frame = thread.callStack.peek();
    if (!frame || !frame.method) {
      return null;
    }
    return {
      className: frame.className || this.findClassNameForMethod(frame.method),
      methodName: frame.method.name,
      descriptor: frame.method.descriptor,
    };
  }

  getCurrentState() {
    const thread = this.threads[this.currentThreadIndex];
    if (!thread || thread.callStack.isEmpty()) return { callStackDepth: 0 };
    const frame = thread.callStack.peek();
    if (!frame) return { callStackDepth: thread.callStack.size() };

    const currentPc = this._resolveFramePc(frame);

    return {
      pc: currentPc,
      stack: frame.stack.items,
      locals: frame.locals,
      callStackDepth: thread.callStack.size(),
      method: { name: frame.method.name, descriptor: frame.method.descriptor },
    };
  }

  _resolveFramePc(frame) {
    if (!frame || !Array.isArray(frame.instructions) || frame.instructions.length === 0) {
      return null;
    }
    const index = Math.min(Math.max(frame.pc, 0), frame.instructions.length - 1);
    const instructionItem = frame.instructions[index];
    if (instructionItem && typeof instructionItem.pc === "number" && instructionItem.pc >= 0) {
      return instructionItem.pc;
    }
    const label = instructionItem ? instructionItem.labelDef : null;
    if (typeof label === "string") {
      const match = /^L(\d+):?$/.exec(label);
      if (match) return Number.parseInt(match[1], 10);
    }
    return index;
  }

  getBacktrace(threadId = this.debugManager.selectedThreadId) {
    const thread = this.threads[threadId];
    if (!thread) return [];
    return thread.callStack.items.map((frame, i) =>
      this._getFrameInfo(frame, i, thread.callStack.size()),
    );
  }

  _getFrameInfo(frame, frameIndex, totalFrames) {
    const className = this.findClassNameForMethod(frame.method);
    const { params } = parseDescriptor(frame.method.descriptor);
    const args = this._extractMethodArguments(frame, params);
    return {
      frameIndex: frameIndex,
      className: className,
      methodName: frame.method.name,
      methodDescriptor: frame.method.descriptor,
      isCurrentFrame: frameIndex === totalFrames - 1,
      arguments: args,
    };
  }

  _extractMethodArguments(frame, params) {
    const args = [];
    let localIndex = 0;
    const isStatic =
      frame.method.flags && frame.method.flags.includes("static");
    if (!isStatic) {
      args.push({
        name: "this",
        type: "reference",
        value: frame.locals[0],
        localIndex: 0,
      });
      localIndex = 1;
    }
    for (let i = 0; i < params.length; i++) {
      const paramType = params[i];
      args.push({
        name: `arg${i}`,
        type: paramType,
        value: frame.locals[localIndex],
        localIndex: localIndex,
      });
      if (paramType === "long" || paramType === "double") {
        localIndex += 2;
      } else {
        localIndex += 1;
      }
    }
    return args;
  }

  inspectStack(threadId = this.debugManager.selectedThreadId) {
    const thread = this.threads[threadId];
    if (!thread || thread.callStack.isEmpty()) return [];
    return thread.callStack.peek().stack.items.map((value, index) => ({
      index,
      value,
      type: this._inferType(value),
    }));
  }

  inspectLocals(threadId = this.debugManager.selectedThreadId) {
    const thread = this.threads[threadId];
    if (!thread || thread.callStack.isEmpty()) return [];
    return this._getLocalVariableInfo(thread.callStack.peek());
  }

  _getLocalVariableInfo(frame) {
    const variables = [];
    const localVarTable = this._getLocalVariableTable(frame.method);
    for (let i = 0; i < frame.locals.length; i++) {
      const value = frame.locals[i];
      let varInfo = {
        index: i,
        value: value,
        type: this._inferType(value),
        name: `local_${i}`,
      };
      if (localVarTable) {
        const varEntry = localVarTable.find((entry) => entry.index === i);
        if (varEntry) {
          varInfo.name = varEntry.name;
          varInfo.type = varEntry.signature || varInfo.type;
        }
      }
      variables.push(varInfo);
    }
    return variables;
  }

  _getLocalVariableTable(method) {
    if (!method.attributes) return null;
    const codeAttribute = method.attributes.find(
      (attr) => attr.type === "code",
    );
    if (!codeAttribute || !codeAttribute.code.attributes) return null;
    const localVarTable = codeAttribute.code.attributes.find(
      (attr) => attr.type === "localvariabletable",
    );
    return localVarTable ? localVarTable.vars : null;
  }

  _inferType(value) {
    if (value === null || value === undefined) return "null";
    if (typeof value === "number")
      return Number.isInteger(value) ? "int" : "double";
    if (typeof value === "string") return "String";
    if (typeof value === "boolean") return "boolean";
    if (Array.isArray(value)) return "array";
    if (typeof value === "object") return value.type || "object";
    return typeof value;
  }

  inspectLocalVariable(index, threadId = this.debugManager.selectedThreadId) {
    const locals = this.inspectLocals(threadId);
    return locals.find((l) => l.index === index) || null;
  }

  inspectStackValue(index, threadId = this.debugManager.selectedThreadId) {
    const stack = this.inspectStack(threadId);
    if (index < 0) {
      index = stack.length + index;
    }
    return stack.find((s) => s.index === index) || null;
  }

  getAvailableVariableNames(threadId = this.debugManager.selectedThreadId) {
    const locals = this.inspectLocals(threadId);
    return locals.map((l) => l.name);
  }

  inspectObject(objRef) {
    if (!objRef || typeof objRef !== "object") return null;
    return { type: objRef._className || objRef.type, fields: objRef.fields || {} };
  }

  stepInto() {
    /* HARDENED: Implemented stub */
    throw new Error("stepInto is not implemented");
  }
  stepOver() {
    /* HARDENED: Implemented stub */
    throw new Error("stepOver is not implemented");
  }
  stepOut() {
    /* HARDENED: Implemented stub */
    throw new Error("stepOut is not implemented");
  }
  stepInstruction() {
    /* HARDENED: Implemented stub */
    throw new Error("stepInstruction is not implemented");
  }
  finish() {
    /* HARDENED: Implemented stub */
    throw new Error("finish is not implemented");
  }
  continue() {
    /* HARDENED: Implemented stub */
    throw new Error("continue is not implemented");
  }
  findVariableByName(name) {
    /* HARDENED: Implemented stub */
    throw new Error("findVariableByName is not implemented");
  }
  _getValueDescription(value) {
    /* HARDENED: Implemented stub */
    throw new Error("_getValueDescription is not implemented");
  }
  getSourceLineMapping(pc, method) {
    if (!method || !method.name) return {};

    // Find the current method's class data
    const thread = this.threads[this.currentThreadIndex];
    if (!thread || thread.callStack.isEmpty()) return {};

    const frame = thread.callStack.peek();
    if (!frame || frame.method.name !== method.name) return {};

    // Get the class name from the current execution context
    const className = frame.className;
    const classData = this.classes[className];
    if (!classData || !classData.ast) return {};

    // Find the method in the class
    const methodItem = classData.ast.classes[0].items.find(
      (item) =>
        item.type === "method" &&
        item.method.name === method.name &&
        item.method.descriptor === method.descriptor,
    );

    if (!methodItem || !methodItem.method.attributes) return {};

    // Find the code attribute
    const codeAttr = methodItem.method.attributes.find(
      (attr) => attr.type === "code",
    );
    if (!codeAttr || !codeAttr.code.attributes) return {};

    // Find the line number table
    const lineTable = codeAttr.code.attributes.find(
      (attr) => attr.type === "linenumbertable",
    );
    if (!lineTable || !lineTable.lines) return {};

    // Create a mapping from PC to line number
    const pcToLineMap = {};
    lineTable.lines.forEach((line) => {
      const pcValue = parseInt(line.label.substring(1)); // Remove 'L' prefix
      pcToLineMap[pcValue] = parseInt(line.lineNumber);
    });

    // Find the line number for the given PC
    // If exact PC match isn't found, find the most recent line before this PC
    let lineNumber = null;
    let instructionLabel = null;

    if (pcToLineMap[pc] !== undefined) {
      lineNumber = pcToLineMap[pc];
      instructionLabel = `L${pc}`;
    } else {
      // Find the closest PC that is less than or equal to the current PC
      let closestPc = -1;
      for (const [pcStr, lineNum] of Object.entries(pcToLineMap)) {
        const pcVal = parseInt(pcStr);
        if (pcVal <= pc && pcVal > closestPc) {
          closestPc = pcVal;
          lineNumber = lineNum;
          instructionLabel = `L${pcVal}`;
        }
      }
    }

    if (lineNumber === null) return {};

    // Find the instruction at this PC
    let instruction = null;
    if (frame.instructions && frame.instructions[frame.pc]) {
      const instructionItem = frame.instructions[frame.pc];
      if (instructionItem.instruction) {
        instruction =
          typeof instructionItem.instruction === "string"
            ? instructionItem.instruction
            : instructionItem.instruction.op || "unknown";
      }
    }

    return {
      line: lineNumber,
      instruction: instruction || "unknown",
      pc: pc,
      label: instructionLabel,
    };
  }
  getSourceFileName(className) {
    const classData = this.classes[className];
    if (!classData || !classData.ast || !classData.ast.classes) return null;
    const item = classData.ast.classes[0].items.find(
      (entry) => entry.attribute && entry.attribute.type === "sourcefile",
    );
    if (!item || item.attribute.value === undefined) return null;
    // convert_tree stores the SourceFile constant with surrounding quotes.
    return String(item.attribute.value).replace(/^"|"$/g, "");
  }

  getDisassemblyView() {
    const thread = this.threads[this.currentThreadIndex];
    if (!thread || thread.callStack.isEmpty()) {
      const error = new Error("No thread or call stack");
      error.code = 'NO_THREAD';
      throw error;
    }

    const frame = thread.callStack.peek();
    if (!frame) {
      /* HARDENED: Replaced quiet failure with an explicit error */
      throw new Error("getDisassemblyView failed: no current frame");
    }

    const className = this.findClassNameForMethod(frame.method);
    if (!className) {
      /* HARDENED: Replaced quiet failure with an explicit error */
      throw new Error("getDisassemblyView failed: could not find class for current method");
    }

    const workspaceEntry = this.classes[className];
    if (!workspaceEntry) {
      /* HARDENED: Replaced quiet failure with an explicit error */
      throw new Error(`getDisassemblyView failed: class data not available for ${className}`);
    }

    try {
      const currentPc = this._resolveFramePc(frame);

      const disassembly = unparseDataStructures(
        workspaceEntry.ast.classes[0],
        workspaceEntry.constantPool,
      );

      const formattedDisassembly = this._formatDisassemblyForDebugView(
        disassembly,
        currentPc,
        className,
      );

      const lineToPcMap = this._createLineToPcMap(disassembly, currentPc);

      return {
        formattedDisassembly: formattedDisassembly,
        lineToPcMap: lineToPcMap,
        classFile: `${className}.class`,
        currentPc: currentPc,
      };
    } catch (error) {
      return {
        formattedDisassembly: `// Error generating disassembly: ${error.message}`,
        lineToPcMap: {},
        classFile: `${className}.class`,
        currentPc: -1,
      };
    }
  }

  _formatDisassemblyForDebugView(disassembly, currentPc, className) {
    const header = `8. Disassembly View\n=====================================\nFile: ${className}.class\nCurrent PC: ${currentPc}\n\n`;

    const lines = disassembly.split("\n");
    const formattedLines = [];
    let lineNumber = 1;

    for (const line of lines) {
      const pcMatch = line.match(/L(\d+):/);
      const linePc = pcMatch ? parseInt(pcMatch[1]) : -1;

      if (linePc === currentPc) {
        formattedLines.push(
          `=>  ${lineNumber.toString().padStart(3)}  ${line}`,
        );
      } else {
        formattedLines.push(
          `    ${lineNumber.toString().padStart(3)}  ${line}`,
        );
      }
      lineNumber++;
    }

    const footer = "\n=====================================";

    return header + formattedLines.join("\n") + footer;
  }

  _createLineToPcMap(disassembly, currentPc) {
    const lineToPcMap = {};
    const lines = disassembly.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const pcMatch = line.match(/L(\d+):/);
      if (pcMatch) {
        const pc = parseInt(pcMatch[1]);
        const displayLineNumber = i + 5;
        lineToPcMap[displayLineNumber] = pc;
      }
    }

    return lineToPcMap;
  }

  createAnnotationProxy(annotation) {
    const jvm = this;
    const proxy = {
      type: annotation.type,
      _annotationData: annotation,
      "annotationType()Ljava/lang/Class;": () => {
        return {
          type: "java/lang/Class",
          _classData: jvm.classes[annotation.type],
          className: annotation.type.replace(/\//g, "."),
        };
      },
      "toString()Ljava/lang/String;": () => {
        let elementsStr = "";
        if (annotation.elements) {
          elementsStr = Object.entries(annotation.elements)
            .map(([key, value]) => {
              let valueStr = value;
              if (typeof value === "string") {
                valueStr = `\"${value}\"`;
              }
              return `${key}=${valueStr}`;
            })
            .join(", ");
        }
        return jvm.internString(
          `@${annotation.type.replace(/\//g, ".")}(${elementsStr})`,
        );
      },
    };

    if (annotation.elements) {
      Object.keys(annotation.elements).forEach((elementName) => {
        const elementValue = annotation.elements[elementName];
        let methodSignature;
        let methodImplementation;

        if (typeof elementValue === "string") {
          methodSignature = `${elementName}()Ljava/lang/String;`;
          methodImplementation = () => jvm.internString(String(elementValue));
        } else if (typeof elementValue === "number") {
          methodSignature = `${elementName}()I`;
          methodImplementation = () => elementValue;
        } else {
          // Default/fallback for other types
          methodSignature = `${elementName}()Ljava/lang/Object;`;
          methodImplementation = () => elementValue;
        }

        proxy[methodSignature] = methodImplementation;
      });
    }

    return proxy;
  }

  _parseAnnotationValue(elementValue) {
    if (!elementValue) {
      /* HARDENED: Replaced quiet failure with an explicit error */
      throw new Error("_parseAnnotationValue requires an elementValue");
    }

    // Handle different annotation value types
    switch (elementValue.tag) {
      case "s": // String
        return this.internString(elementValue.stringValue);
      case "I": // Integer
        return elementValue.intValue;
      case "Z": // Boolean
        return elementValue.booleanValue;
      case "J": // Long
        return elementValue.longValue;
      case "F": // Float
        return elementValue.floatValue;
      case "D": // Double
        return elementValue.doubleValue;
      case "c": // Class
        // TODO: Implement class literal support
        throw new Error("_parseAnnotationValue: class literal support is not implemented");
      case "e": // Enum
        // TODO: Implement enum support
        throw new Error("_parseAnnotationValue: enum support is not implemented");
      case "@": // Annotation
        return this.createAnnotationProxy(elementValue.annotationValue);
      case "[": // Array
        return (
          elementValue.arrayValue.map((val) =>
            this._parseAnnotationValue(val),
          )
        );
      default:
        throw new Error(`_parseAnnotationValue: unhandled tag ${elementValue.tag}`);
    }
  }

  createAnnotationProxy(annotation) {
    const jvm = this;
    const proxy = {
      type: annotation.type,
      _annotationData: annotation,
      "annotationType()Ljava/lang/Class;": () => {
        return {
          type: "java/lang/Class",
          _classData: jvm.classes[annotation.type],
          className: annotation.type.replace(/\//g, "."),
        };
      },
      "toString()Ljava/lang/String;": () => {
        let elementsStr = "";
        if (annotation.elements) {
          elementsStr = Object.entries(annotation.elements)
            .map(([key, value]) => {
              let valueStr = value;
              if (typeof value === "string") {
                valueStr = `\"${value}\"`;
              }
              return `${key}=${valueStr}`;
            })
            .join(", ");
        }
        return jvm.internString(
          `@${annotation.type.replace(/\//g, ".")}(${elementsStr})`,
        );
      },
    };

    if (annotation.elements) {
      Object.keys(annotation.elements).forEach((elementName) => {
        const elementValue = annotation.elements[elementName];
        let methodSignature;
        let methodImplementation;

        if (typeof elementValue === "string") {
          methodSignature = `${elementName}()Ljava/lang/String;`;
          methodImplementation = () => jvm.internString(String(elementValue));
        } else if (typeof elementValue === "number") {
          methodSignature = `${elementName}()I`;
          methodImplementation = () => elementValue;
        } else {
          // Default/fallback for other types
          methodSignature = `${elementName}()Ljava/lang/Object;`;
          methodImplementation = () => elementValue;
        }

        proxy[methodSignature] = methodImplementation;
      });
    }

    return proxy;
  }
}

module.exports = { JVM };

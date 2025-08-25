const Stack = require("./stack");
const {
  loadClassByPath,
  loadClassByPathSync: loadConvertedClass,
} = require("./classLoader");
const { parseDescriptor } = require("./typeParser");
const { primitiveTypeDescriptors, arrayPrimitiveTypeDescriptors } = require("./constants");
const {
  formatInstruction,
  unparseDataStructures,
  convertJson,
} = require("./convert_tree");
const jreClasses = require("./jre");
const dispatch = require("./instructions");
const Frame = require("./frame");
const DebugManager = require("./DebugManager");
const JNI = require("./jni");
const fs = require("fs");
const path = require("path");
const { getAST } = require("jvm_parser");
const { JreBootstrap } = require("./jre-bootstrap");

class JVM {
  constructor(options = {}) {
    this.threads = [];
    this.currentThreadIndex = 0;
    this.classes = {}; // className -> { ast, constantPool }
    this.classInitializationState = new Map();
    this.invokedynamicCache = new Map();
    this.classObjectCache = new Map(); // className -> Class object (for maintaining identity)
    this.jre = jreClasses;
    this.debugManager = new DebugManager();
    this.classpath = options.classpath || ".";
    this.verbose = options.verbose || false;
    this.nextHashCode = 1;
    this.maxStackDepth = options.maxStackDepth || 1024;

    // Make fs and path available for JreBootstrap (only in Node.js environment)
    if (typeof window === "undefined") {
      this.fs = fs;
      this.path = path;
    }

    // Initialize JNI system
    this.jni = new JNI(this);
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
    // First check JNI registry for registered native methods
    const nativeMethod = this.jni.findNativeMethod(
      className,
      methodName,
      descriptor,
    );
    if (nativeMethod) {
      return nativeMethod;
    }

    // It's not a JNI method. Only proceed if it's a JRE class.
    if (!this.jre[className]) {
      return null;
    }

    // Continue with original JRE method lookup
    let currentClass = this.jre[className];
    while (currentClass) {
      const methodKey = `${methodName}${descriptor}`;

      // Check instance methods
      const method = currentClass.methods && currentClass.methods[methodKey];
      if (method) {
        return method;
      }

      // Check static methods
      const staticMethod =
        currentClass.staticMethods && currentClass.staticMethods[methodKey];
      if (staticMethod) {
        return staticMethod;
      }

      // Check superclass
      currentClass = currentClass.super ? this.jre[currentClass.super] : null;
    }

    // If no exact match found and this is a MethodHandle.invoke method,
    // try the universal varargs signature that can handle any parameters
    if (className === 'java/lang/invoke/MethodHandle' && methodName === 'invoke') {
      const methodHandleClass = this.jre['java/lang/invoke/MethodHandle'];
      if (methodHandleClass && methodHandleClass.methods) {
        const universalMethod = methodHandleClass.methods['invoke([Ljava/lang/Object;)Ljava/lang/Object;'];
        if (universalMethod) {
          return universalMethod;
        }
      }
    }

    return null;
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

      // Set default value based on descriptor
      let defaultValue = null;
      if (
        field.descriptor === "I" ||
        field.descriptor === "B" ||
        field.descriptor === "S"
      ) {
        defaultValue = 0; // int, byte, short
      } else if (field.descriptor === "J") {
        defaultValue = BigInt(0); // long
      } else if (field.descriptor === "F" || field.descriptor === "D") {
        defaultValue = 0.0; // float, double
      } else if (field.descriptor === "Z") {
        defaultValue = 0; // boolean (false)
      } else if (field.descriptor === "C") {
        defaultValue = 0; // char ('\0')
      }
      // Object references default to null

      classData.staticFields[fieldKey] = defaultValue;
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
        const result = await this.executeTick();
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

  async run(classFilePath, options = {}) {
    if (options.classpath) {
      this.classpath = options.classpath;
    } else if (classFilePath.includes(path.sep)) {
      this.classpath = path.dirname(classFilePath);
    }
    const classData = await this.loadClassAsync(classFilePath, options);
    if (!classData || !classData.ast) {
      throw new Error(`Class not found: ${classFilePath}`);
    }

    const mainMethod = this.findMainMethod(classData);
    if (!mainMethod) {
      console.error("main method not found");
      return;
    }

    const mainThread = {
      id: 0,
      name: "main",
      callStack: new Stack(),
      status: "runnable",
      pendingException: null,
    };
    this.threads.push(mainThread);

    // Initialize the main class before running main method
    // This ensures static blocks execute before main method starts
    const className = classData.ast.classes[0].className;
    const wasFramePushed = await this.initializeClassIfNeeded(
      className,
      mainThread,
    );

    if (wasFramePushed) {
      // If a <clinit> frame was pushed, we need to execute it to completion first
      // Wait until all frames related to class initialization complete
      // This includes the <clinit> frame and any methods it calls
      const originalStackSize = mainThread.callStack.size();
      while (mainThread.callStack.size() >= originalStackSize) {
        const result = await this.executeTick();
        if (result.completed) break;
      }
    }

    const mainFrame = new Frame(mainMethod);
    mainFrame.className = className; // Add className to the frame
    mainThread.callStack.push(mainFrame);

    if (!this.debugManager.debugMode || !this.debugManager.isPaused) {
      await this.execute();
    }
  }

  async execute() {
    this.debugManager.resume();

    try {
      while (!this.debugManager.isPaused) {
        const result = await this.executeTick();
        if (result.completed) {
          this.debugManager.pause();
          return { completed: true, paused: false };
        }

        // Check for breakpoints
        const currentThread = this.threads[this.currentThreadIndex];
        if (
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
                if (this.debugManager.breakpoints.has(currentPc)) {
                  this.debugManager.pause();
                }
              }
            }
          }
        }
        // Yield to the event loop to prevent blocking on long-running code without breakpoints
        await new Promise((resolve) => setImmediate(resolve));
      }
    } catch (e) {
      this.debugManager.pause();
      throw e;
    }

    return { paused: true, completed: false };
  }

  async executeTick() {
    // On each tick, check for threads that need to be woken up.
    for (const t of this.threads) {
      if (t.status === "SLEEPING" && Date.now() >= t.sleepUntil) {
        t.status = "runnable";
        delete t.sleepUntil;
      }
      if (t.status === "JOINING" && t.joiningOn.status === "terminated") {
        t.status = "runnable";
        delete t.joiningOn;
      }
      if (
        t.status === "BLOCKED" &&
        t.blockingOn &&
        !t.blockingOn.isLocked &&
        !t.blockingOn._isReentrantLock
      ) {
        t.status = "runnable";
      }
    }

    if (this.threads.every((t) => t.status === "terminated")) {
      return { completed: true };
    }

    // console.error(`Tick. Current thread: ${this.currentThreadIndex}. Statuses: ${this.threads.map(t => `${t.id}:${t.status}`).join(', ')}`);

    let thread = this.threads[this.currentThreadIndex];

    // Find the next runnable thread
    let initialThreadIndex = this.currentThreadIndex;
    while (thread.status !== "runnable") {
      this.currentThreadIndex =
        (this.currentThreadIndex + 1) % this.threads.length;
      thread = this.threads[this.currentThreadIndex];
      if (this.currentThreadIndex === initialThreadIndex) {
        // We've looped through all threads and none are runnable.
        // This could be a deadlock or all threads are waiting/blocked.
        const nonTerminated = this.threads.filter(
          (t) => t.status !== "terminated",
        );
        if (nonTerminated.length > 0) {
          // Yield to allow time to pass for sleeping threads or external events.
          await new Promise((resolve) => setImmediate(resolve));
          return { completed: false };
          //		continue;
        } else {
          // All threads are terminated.
          return { completed: true };
        }
      }
    }

    const callStack = thread.callStack;

    if (callStack.size() > this.maxStackDepth) {
      const error = {
        type: "java/lang/StackOverflowError",
        message: "Stack overflow",
      };
      this.handleException(error, -1, thread);
      return { completed: false };
    }

    if (callStack.isEmpty()) {
      thread.status = "terminated";
      this.currentThreadIndex =
        (this.currentThreadIndex + 1) % this.threads.length;
      return { completed: false };
    }

    const frame = callStack.peek();
    if (frame.pc >= frame.instructions.length) {
      const popped = callStack.pop();
      if (thread.isAwaitingReflectiveCall) {
        let ret = null;
        if (!popped.stack.isEmpty()) {
          ret = popped.stack.pop();
        }
        await thread.reflectiveCallResolver(ret);
        thread.isAwaitingReflectiveCall = false;
        thread.reflectiveCallResolver = null;
      }
      return { completed: false };
    }

    const instructionItem = frame.instructions[frame.pc];
    const instruction = instructionItem.instruction;

    frame.pc++;

    try {
      if (instruction) {
        await this.executeInstruction(instruction, frame, thread);
      }
    } catch (e) {
      const isJavaException =
        e && typeof e.type === "string" && e.type.includes("/");
      if (!isJavaException && this.verbose) {
        console.error(
          `>>>>>> BUG HUNT: Caught exception in executeTick for thread ${thread.id} <<<<<<`,
        );
        console.error(e); // Log the raw error object to see its stack trace
      }
      const label = instructionItem.labelDef;
      const currentPc = label
        ? parseInt(label.substring(1, label.length - 1))
        : -1;
      this.handleException(e, currentPc, thread);
    }

    if (this.threads.length > 0) {
      this.currentThreadIndex =
        (this.currentThreadIndex + 1) % this.threads.length;
    }

    return { completed: false };
  }

  shouldPause(currentPc, frame) {
    return false;
  }

  shouldPauseAfterStep(currentPc, frame) {
    return false;
  }

  async executeInstruction(instruction, frame, thread) {
    await dispatch(frame, instruction, this, thread);
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

  async loadClassByName(classNameWithSlashes) {
    if (this.classes[classNameWithSlashes]) {
      return this.classes[classNameWithSlashes];
    }

    // Handle array classes (e.g., [I, [[Ljava/lang/String;, etc.)
    if (classNameWithSlashes.startsWith('[')) {
      return this.createArrayClass(classNameWithSlashes);
    }

    const classFilePath = path.join(
      this.classpath,
      `${classNameWithSlashes}.class`,
    );
    const classData = await this.loadClassAsync(classFilePath);
    if (classData && classData.ast) {
      this.classes[classNameWithSlashes] = classData;
    }
    return classData;
  }

  /**
   * Get or create a Class object for the given class name, maintaining object identity
   * @param {string} classNameWithSlashes - Class name with slashes (e.g., "java/lang/String")
   * @returns {Promise<Object>} The Class object
   */
  async getClassObject(classNameWithSlashes) {
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

    // Load class data for regular classes
    const classData = await this.loadClassByName(classNameWithSlashes);
    if (!classData) {
      throw { type: 'java/lang/ClassNotFoundException', message: classNameWithSlashes };
    }


    const classObj = {
      type: "java/lang/Class",
      _classData: classData,
    };
    this.classObjectCache.set(classNameWithSlashes, classObj);
    return classObj;
  }

  async initializeClassIfNeeded(className, thread) {
    if (
      !className ||
      this.classInitializationState.get(className) === "INITIALIZED"
    ) {
      return false;
    }

    if (this.classInitializationState.get(className) === "INITIALIZING") {
      // In a real multi-threaded JVM, the current thread would wait.
      return false;
    }

    if (this.verbose) {
      console.log(`Initializing class: ${className}`);
    }

    this.classInitializationState.set(className, "INITIALIZING");

    // For JRE classes, we should already have them preloaded in this.classes
    let classData = this.classes[className];
    if (!classData) {
      // Only try to load from file system if not a JRE class
      if (!this.jre[className]) {
        classData = await this.loadClassByName(className);
      } else {
        // JRE class should have been preloaded, something went wrong
        if (this.verbose) {
          console.warn(`JRE class ${className} not found in preloaded classes`);
        }
        this.classInitializationState.set(className, "INITIALIZED");
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
          return true;
        }
      }

      // Initialize static fields with default values first
      if (!classData.staticFields) {
        classData.staticFields = new Map();

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

            // Set default value based on descriptor
            let defaultValue = null;
            if (
              field.descriptor === "I" ||
              field.descriptor === "B" ||
              field.descriptor === "S"
            ) {
              defaultValue = 0; // int, byte, short
            } else if (field.descriptor === "J") {
              defaultValue = BigInt(0); // long
            } else if (field.descriptor === "F" || field.descriptor === "D") {
              defaultValue = 0.0; // float, double
            } else if (field.descriptor === "Z") {
              defaultValue = 0; // boolean (false)
            } else if (field.descriptor === "C") {
              defaultValue = 0; // char ('\0')
            }
            // Object references default to null

            classData.staticFields.set(fieldKey, defaultValue);

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
        thread.callStack.push(clinitFrame);
        // We pushed a bytecode initializer, so the calling instruction needs to be re-run.
        // We set the state to initialized here to prevent re-entry, but the <clinit>
        // code itself will run before any other instruction on this thread.
        this.classInitializationState.set(className, "INITIALIZED");
        return true;
      }
    }

    this.classInitializationState.set(className, "INITIALIZED");
    return false;
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

  findStaticInitializer(classData) {
    const clinitMethod = classData.ast.classes[0].items.find((item) => {
      return (
        item.type === "method" &&
        item.method.name === "<clinit>" &&
        item.method.descriptor === "()V"
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

    const classData = this.classes[className];
    if (!classData) return false;

    // Check superclass
    if (this.isInstanceOf(classData.ast.classes[0].superClassName, target)) {
      return true;
    }

    // Check interfaces
    const interfaces = classData.ast.classes[0].interfaces;
    if (interfaces) {
      for (const iface of interfaces) {
        if (this.isInstanceOf(iface, target)) {
          return true;
        }
      }
    }
    return false;
  }

  handleException(exception, pc, thread) {
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

    const table = frame.exceptionTable;
    if (table) {
      for (const entry of table) {
        if (pcToCheck >= entry.start_pc && pcToCheck < entry.end_pc) {
          if (entry.catch_type === "any") {
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
              return;
            }
          } else if (this.isInstanceOf(exception.type, entry.catch_type)) {
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
              return;
            }
          }
        }
      }
    }

    callStack.pop();
    this.handleException(exception, -1, thread);
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

  async deserialize(state) {
    if (state.classpath) {
      this.classpath = state.classpath;
    }
    this.threads = await Promise.all(
      state.threads.map(async (threadState) => {
        const thread = {
          id: threadState.id,
          status: threadState.status,
          callStack: new Stack(),
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
    this.classInitializationState = new Map(state.classInitializationState);
    this.nextHashCode = state.nextHashCode;
    if (state.debugManager) {
      this.debugManager.deserialize(state.debugManager);
    }
  }

  findClassNameForMethod(method) {
    for (const [className, classData] of Object.entries(this.classes)) {
      if (
        classData &&
        classData.ast &&
        classData.ast.classes &&
        classData.ast.classes[0]
      ) {
        const methods = classData.ast.classes[0].items.filter(
          (item) => item.type === "method",
        );
        if (methods.some((item) => item.method === method)) {
          return className;
        }
      }
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
  addBreakpoint(pc) {
    this.debugManager.addBreakpoint(pc);
  }
  removeBreakpoint(pc) {
    this.debugManager.removeBreakpoint(pc);
  }
  clearBreakpoints() {
    this.debugManager.clearBreakpoints();
  }

  getCurrentState() {
    const thread = this.threads[this.currentThreadIndex];
    if (!thread || thread.callStack.isEmpty()) return { callStackDepth: 0 };
    const frame = thread.callStack.peek();
    if (!frame) return { callStackDepth: thread.callStack.size() };

    const instructionItem = frame.instructions[frame.pc];
    const label = instructionItem ? instructionItem.labelDef : null;
    const currentPc = label
      ? parseInt(label.substring(1, label.length - 1))
      : -1;

    return {
      pc: currentPc,
      stack: frame.stack.items,
      locals: frame.locals,
      callStackDepth: thread.callStack.size(),
      method: { name: frame.method.name, descriptor: frame.method.descriptor },
    };
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
    return { type: objRef.type, fields: objRef.fields || {} };
  }

  stepInto() {}
  stepOver() {}
  stepOut() {}
  stepInstruction() {}
  finish() {}
  continue() {}
  findVariableByName(name) {
    return null;
  }
  _getValueDescription(value) {
    return "";
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
  getSourceFileName(method) {
    return null;
  }

  getDisassemblyView() {
    const thread = this.threads[this.currentThreadIndex];
    if (!thread || thread.callStack.isEmpty()) {
      return {
        formattedDisassembly: "",
        lineToPcMap: {},
        classFile: null,
        currentPc: -1,
      };
    }

    const frame = thread.callStack.peek();
    if (!frame) {
      return {
        formattedDisassembly: "",
        lineToPcMap: {},
        classFile: null,
        currentPc: -1,
      };
    }

    const className = this.findClassNameForMethod(frame.method);
    if (!className) {
      return {
        formattedDisassembly: "// Could not find class for current method",
        lineToPcMap: {},
        classFile: null,
        currentPc: -1,
      };
    }

    const workspaceEntry = this.classes[className];
    if (!workspaceEntry) {
      return {
        formattedDisassembly: "// Class data not available",
        lineToPcMap: {},
        classFile: className,
        currentPc: -1,
      };
    }

    try {
      let currentPc = -1;
      if (frame.pc < frame.instructions.length) {
        const instructionItem = frame.instructions[frame.pc];
        const label = instructionItem ? instructionItem.labelDef : null;
        currentPc = label ? parseInt(label.substring(1, label.length - 1)) : -1;
      }

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
    if (!elementValue) return null;

    // Handle different annotation value types
    switch (elementValue.tag) {
      case "s": // String
        return this.internString(elementValue.stringValue || "");
      case "I": // Integer
        return elementValue.intValue || 0;
      case "Z": // Boolean
        return elementValue.booleanValue || false;
      case "J": // Long
        return elementValue.longValue || 0;
      case "F": // Float
        return elementValue.floatValue || 0.0;
      case "D": // Double
        return elementValue.doubleValue || 0.0;
      case "c": // Class
        // TODO: Implement class literal support
        return null;
      case "e": // Enum
        // TODO: Implement enum support
        return null;
      case "@": // Annotation
        return this.createAnnotationProxy(elementValue.annotationValue);
      case "[": // Array
        return (
          elementValue.arrayValue?.map((val) =>
            this._parseAnnotationValue(val),
          ) || []
        );
      default:
        return null;
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

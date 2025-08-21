const { parseDescriptor } = require("../typeParser");
const Frame = require("../frame");
const Stack = require("../stack");
const path = require("path");
const { MethodHandle, MethodType, Lookup } = require("../jre/java/lang/invoke");
const { ASYNC_METHOD_SENTINEL } = require("../constants");

// Helper function to format numbers according to Java's rules
function formatJavaNumber(value, type) {
  if (typeof value === "number") {
    // For float values, always show decimal point even for whole numbers
    if (type === "float") {
      if (Number.isInteger(value)) {
        return value + ".0";
      }
      // For float, use 7 decimal places like Java typically does
      return value.toFixed(7).replace(/\.?0+$/, "");
    }
    // For double values, format appropriately
    if (type === "double") {
      if (Number.isInteger(value)) {
        const result = value + ".0";

        return result;
      }
      const str = value.toString();
      // If it's in scientific notation, convert to fixed point
      if (str.includes("e")) {
        const result = value.toFixed(15).replace(/\.?0+$/, "");

        return result;
      }

      return str;
    }
    // For integers, return as string without decimal
    if (Number.isInteger(value)) {
      const result = value.toString();

      return result;
    }
    // For other floating-point numbers
    const str = value.toString();
    // If it's in scientific notation, convert to fixed point
    if (str.includes("e")) {
      const result = value.toFixed(15).replace(/\.?0+$/, "");

      return result;
    }

    return str;
  }
  const result = String(value);

  return result;
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
      message: `Cannot invoke "${className.substring(className.lastIndexOf("/") + 1)}.${methodName}()" because the object reference is null`,
    };
  }

  let currentClassName = boxedObj.type;

  // Handle arrays - they inherit from Object
  if (currentClassName && currentClassName.startsWith("[")) {
    const jreMethod = jvm._jreFindMethod(
      "java/lang/Object",
      methodName,
      descriptor,
    );
    if (jreMethod) {
      let result = jreMethod(jvm, boxedObj, args, thread);
      if (result !== ASYNC_METHOD_SENTINEL) {
        const { returnType } = parseDescriptor(descriptor);
        if (returnType !== "V" && result !== undefined) {
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
        if (returnType !== "V" && result !== undefined) {
          if (typeof result === "boolean") {
            result = result ? 1 : 0;
          }
          frame.stack.push(result);
        }
      }
      return;
    }

    let classData = jvm.classes[currentClassName];
    if (!classData) {
      if (jvm.jre[currentClassName]) {
        break; // It's a JRE class, don't try to load it from file.
      }
      classData = await jvm.loadClassByName(currentClassName);
    }

    if (classData) {
      const method = jvm.findMethod(classData, methodName, descriptor);
      if (method) {
        const newFrame = new Frame(method);
        newFrame.className = currentClassName; // Add className to the frame
        newFrame.locals[0] = obj; // 'this'
        for (let i = 0; i < args.length; i++) {
          newFrame.locals[i + 1] = args[i];
        }
        thread.callStack.push(newFrame);
        return;
      }
      currentClassName = classData.ast.classes[0].superClassName;
    } else {
      currentClassName = null;
    }
  }

  throw new Error(
    `Unsupported invokevirtual: ${boxedObj?.type || typeof boxedObj}.${methodName}${descriptor}`,
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
    if (returnType !== "V" && result !== undefined) {
      frame.stack.push(result);
    }
    return;
  }

  // If it's a JRE class and we didn't find a method, it's likely unimplemented.
  if (jvm.jre[className]) {
    return;
  }

  // Otherwise, it must be a user-defined class.
  let workspaceEntry = jvm.classes[className];
  if (!workspaceEntry) {
    workspaceEntry = await jvm.loadClassByName(className);
  }

  const method = jvm.findMethod(workspaceEntry, methodName, descriptor);
  if (method) {
    if (method.flags && method.flags.includes("native")) {
      // This case should be handled by the _jreFindMethod call above,
      // but as a fallback, we can do nothing.
    } else {
      // We found a bytecode method.
      const newFrame = new Frame(method);
      newFrame.className = className; // Add className to the frame
      const { params } = parseDescriptor(descriptor);
      for (let i = params.length - 1; i >= 0; i--) {
        newFrame.locals[i] = frame.stack.pop();
      }
      thread.callStack.push(newFrame);
    }
  } else {
    // Method not found - this is expected for some JVM methods that aren't implemented
    // Don't throw an error, just return silently
  }
}

async function invokespecial(frame, instruction, jvm, thread) {
  const [_, className, [methodName, descriptor]] = instruction.arg;
  const { params } = parseDescriptor(descriptor);
  const args = [];
  for (let i = 0; i < params.length; i++) {
    args.unshift(frame.stack.pop());
  }
  const obj = frame.stack.pop();

  let jreMethod = null;
  if (jvm.jre[className]) {
    jreMethod = jvm._jreFindMethod(className, methodName, descriptor);
  }

  if (jreMethod) {
    await jreMethod(jvm, obj, args);
    return;
  }

  // For user-defined methods (constructors, private methods, super calls)
  let workspaceEntry = jvm.classes[className];
  if (!workspaceEntry) {
    if (jvm.jre[className]) {
      return;
    }
    // If class is not loaded, loading it.
    workspaceEntry = await jvm.loadClassByName(className);
    if (!workspaceEntry) {
      console.error(`Class not found for invokespecial: ${className}`);
      return;
    }
  }

  const method = jvm.findMethod(workspaceEntry, methodName, descriptor);
  if (method) {
    const newFrame = new Frame(method);
    newFrame.className = className; // Add className to the frame
    let localIndex = 0;
    newFrame.locals[localIndex++] = obj; // 'this'
    for (const arg of args) {
      newFrame.locals[localIndex++] = arg;
    }
    thread.callStack.push(newFrame);
  } else if (methodName === "<init>") {
    // If no constructor is found, it might be an empty constructor from a superclass (e.g. Object).
    // For now, we do nothing, assuming the object is already created by 'new'.
  } else {
    throw new Error(
      `Unsupported invokespecial: ${className}.${methodName}${descriptor}`,
    );
  }
}

async function invokedynamic(frame, instruction, jvm, thread) {
  const className = jvm.findClassNameForMethod(frame.method);
  const pc = frame.pc - 1;
  const cacheKey = `${className}.${frame.method.name}.${pc}`;

  // Check cache first
  const cachedCallSite = jvm.invokedynamicCache.get(cacheKey);
  if (cachedCallSite) {
    const runnable = {
      type: "java/lang/Runnable",
      methodHandle: cachedCallSite.target,
    };
    frame.stack.push(runnable);
    return;
  }

  // 1. Get the pre-resolved info from the instruction argument
  const invokeDynamicInfo = instruction.arg;
  const bsmAttrIndex = invokeDynamicInfo.bootstrap_method_attr_index;
  const nameAndType = invokeDynamicInfo.nameAndType;

  // 2. Get the bootstrap method from the class's attribute
  const classData = jvm.classes[className];
  const bsm = classData.ast.classes[0].bootstrapMethods[bsmAttrIndex];

  // 3. Prepare arguments for the bootstrap method call
  const lookup = new Lookup();
  const invokedName = nameAndType.name;
  const invokedType = new MethodType(nameAndType.descriptor);

  const staticArgs = bsm.arguments.map((arg) => {
    if (arg.type === "MethodHandle") {
      return new MethodHandle(arg.value.kind, arg.value.reference);
    }
    if (arg.type === "MethodType") {
      return new MethodType(arg.value);
    }
    return arg.value;
  });

  const bsmArgs = [lookup, invokedName, invokedType, ...staticArgs];

  if (
    bsm.method_ref.value.reference.className ===
    "java/lang/invoke/StringConcatFactory"
  ) {
    const recipe = bsm.arguments[0].value;
    const { params } = parseDescriptor(nameAndType.descriptor);
    const dynamicArgs = [];
    for (let i = 0; i < params.length; i++) {
      dynamicArgs.unshift(frame.stack.pop());
    }

    let result = "";
    let argIndex = 0;
    for (let i = 0; i < recipe.length; i++) {
      const char = recipe.charAt(i);
      if (char === "\u0001") {
        const arg = dynamicArgs[argIndex];
        const paramType = params[argIndex];

        argIndex++;
        // Convert Java objects to strings properly
        if (arg && typeof arg === "object" && arg.value !== undefined) {
          // Java String object
          result += arg.value;
        } else if (arg && typeof arg === "object" && arg.toString) {
          result += arg.toString();
        } else {
          result += formatJavaNumber(arg, paramType);
        }
      } else {
        result += char;
      }
    }
    frame.stack.push(jvm.internString(result));
    return;
  }

  // The next step is to actually invoke the bsm.method_ref with these args.
  // We can reuse the invokestatic logic for this.

  // 4. Push arguments onto the stack for the BSM call.
  // The BSM arguments are pushed onto the stack of the *current* frame.
  bsmArgs.forEach((arg) => frame.stack.push(arg));

  // 5. Create a fake instruction to pass to the invokestatic handler.
  const bsmInstruction = {
    op: "invokestatic",
    arg: [
      "Method",
      bsm.method_ref.value.reference.className,
      [
        bsm.method_ref.value.reference.nameAndType.name,
        bsm.method_ref.value.reference.nameAndType.descriptor,
      ],
    ],
  };

  // 6. Call the invokestatic handler directly.
  await invokestatic(frame, bsmInstruction, jvm, thread);

  // After the BSM runs, the CallSite object is on the stack.
  const callSite = frame.stack.pop();

  // Store the newly created CallSite in the cache
  jvm.invokedynamicCache.set(cacheKey, callSite);

  const targetMethodHandle = callSite.target;

  // For a lambda, the result of invokedynamic is a functional interface object (e.g., Runnable).
  // When its method is called (e.g., run()), the target method handle is invoked.
  if (
    bsm.method_ref.value.reference.className ===
    "java/lang/invoke/LambdaMetafactory"
  ) {
    // Create a functional interface object (e.g., Runnable).
    const functionalInterface = {
      type: invokedType.returnType, // The functional interface type
      methodHandle: targetMethodHandle, // The implementation of the interface's method
    };

    // Push the resulting functional interface object onto the stack.
    frame.stack.push(functionalInterface);
  }
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
    // It's a lambda. Push the args back for invokestatic.
    for (const arg of args) {
      frame.stack.push(arg);
    }

    const targetMethodHandle = boxedObj.methodHandle;

    // Now, invoke the target method. It's a static method in this case.
    const lambdaInstruction = {
      op: "invokestatic",
      arg: [
        "Method",
        targetMethodHandle.reference.className,
        [
          targetMethodHandle.reference.nameAndType.name,
          targetMethodHandle.reference.nameAndType.descriptor,
        ],
      ],
    };

    await invokestatic(frame, lambdaInstruction, jvm, thread);
    return;
  }

  // For regular interface implementations, treat like invokevirtual
  const jreClass = jvm.jre[boxedObj.type];
  if (
    jreClass &&
    jreClass.methods &&
    jreClass.methods[methodName + descriptor]
  ) {
    const result = jreClass.methods[methodName + descriptor](
      jvm,
      boxedObj,
      args,
      thread,
    );
    const { returnType } = parseDescriptor(descriptor);
    if (returnType !== "V" && result !== undefined) {
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
      if (returnType !== "V" && result !== undefined) {
        frame.stack.push(result);
      }
      return;
    }
  }

  // First check JRE methods
  let currentClassName = boxedObj.type;
  while (currentClassName) {
    let jreMethod = null;
    if (jvm.jre[currentClassName]) {
      jreMethod = jvm._jreFindMethod(currentClassName, methodName, descriptor);
    }
    if (jreMethod) {
      let result = jreMethod(jvm, boxedObj, args, thread);
      if (result !== ASYNC_METHOD_SENTINEL) {
        const { returnType } = parseDescriptor(descriptor);
        if (returnType !== "V" && result !== undefined) {
          if (typeof result === "boolean") {
            result = result ? 1 : 0;
          }
          frame.stack.push(result);
        }
      }
      return;
    }

    let classData = jvm.classes[currentClassName];
    if (!classData) {
      if (jvm.jre[currentClassName]) {
        break; // It's a JRE class, don't try to load it from file.
      }
      classData = await jvm.loadClassByName(currentClassName);
    }

    if (classData) {
      const method = jvm.findMethod(classData, methodName, descriptor);
      if (method) {
        const newFrame = new Frame(method);
        newFrame.className = currentClassName; // Add className to the frame
        newFrame.locals[0] = boxedObj; // 'this'
        for (let i = 0; i < args.length; i++) {
          newFrame.locals[i + 1] = args[i];
        }
        thread.callStack.push(newFrame);
        return;
      }
      currentClassName = classData.ast.classes[0].superClassName;
    } else {
      currentClassName = null;
    }
  }

  throw new Error(
    `Unsupported invokeinterface: ${boxedObj.type}.${methodName}${descriptor}`,
  );
}

const invokeHandlers = {
  invokevirtual,
  invokestatic,
  invokespecial,
  invokedynamic,
  invokeinterface,
};

module.exports = invokeHandlers;

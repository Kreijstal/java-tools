const { parseDescriptor } = require('../typeParser');
const Frame = require('../frame');
const Stack = require('../stack');
const path = require('path');
const { MethodHandle, MethodType, Lookup } = require('../jre/java/lang/invoke');
const { ASYNC_METHOD_SENTINEL } = require('../constants');

// Helper function to auto-box primitives when needed
function autoboxPrimitive(jvm, value) {
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      // Integer autoboxing
      return {
        type: 'java/lang/Integer',
        value: value,
        toString: function() { return this.value.toString(); }
      };
    } else {
      // Double autoboxing
      return {
        type: 'java/lang/Double',
        value: value,
        toString: function() { return this.value.toString(); }
      };
    }
  }
  if (typeof value === 'boolean') {
    // Boolean autoboxing
    return {
      type: 'java/lang/Boolean',
      value: value, // Store the boolean value directly
      booleanValue: value,   // Store original boolean value
      toString: function() { return value ? 'true' : 'false'; }
    };
  }
  if (typeof value === 'string') {
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

  // Auto-box primitive if needed (when a primitive is being used as an object)
  let boxedObj = obj;
  if (typeof obj === 'number' || typeof obj === 'boolean') {
    boxedObj = autoboxPrimitive(jvm, obj);
  }

  // Check for null object reference
  if (boxedObj === null) {
    throw {
      type: 'java/lang/NullPointerException',
      message: 'Attempted to invoke virtual method on null object reference'
    };
  }

  let currentClassName = boxedObj.type;
  
  // Handle arrays - they inherit from Object
  if (currentClassName && currentClassName.startsWith('[')) {
    const jreMethod = jvm._jreFindMethod('java/lang/Object', methodName, descriptor);
    if (jreMethod) {
      let result = jreMethod(jvm, boxedObj, args, thread);
      if (result !== ASYNC_METHOD_SENTINEL) {
        const { returnType } = parseDescriptor(descriptor);
        if (returnType !== 'V' && result !== undefined) {
          if (typeof result === 'boolean') {
            result = result ? 1 : 0;
          }
          frame.stack.push(result);
        }
      }
      return;
    }
  }
  
  while (currentClassName) {
    const jreMethod = jvm._jreFindMethod(currentClassName, methodName, descriptor);
    if (jreMethod) {
      let result = jreMethod(jvm, boxedObj, args, thread);
      if (result !== ASYNC_METHOD_SENTINEL) {
        const { returnType } = parseDescriptor(descriptor);
        if (returnType !== 'V' && result !== undefined) {
          if (typeof result === 'boolean') {
            result = result ? 1 : 0;
          }
          frame.stack.push(result);
        }
      }
      return;
    }

    let classData = jvm.classes[currentClassName];
    if (!classData) {
      classData = await jvm.loadClassByName(currentClassName);
    }

    if (classData) {
      const method = jvm.findMethod(classData, methodName, descriptor);
      if (method) {
        const newFrame = new Frame(method);
        newFrame.locals[0] = obj; // 'this'
        for (let i = 0; i < args.length; i++) {
          newFrame.locals[i+1] = args[i];
        }
        thread.callStack.push(newFrame);
        return;
      }
      currentClassName = classData.ast.classes[0].superClassName;
    } else {
      currentClassName = null;
    }
  }

  throw new Error(`Unsupported invokevirtual: ${boxedObj?.type || typeof boxedObj}.${methodName}${descriptor}`);
}

async function invokestatic(frame, instruction, jvm, thread) {
  const [_, className, [methodName, descriptor]] = instruction.arg;

  const wasFramePushed = await jvm.initializeClassIfNeeded(className, thread);
  if (wasFramePushed) {
    frame.pc--;
    return;
  }

  const jreMethod = jvm._jreFindMethod(className, methodName, descriptor);

  if (jreMethod) {
    const { params } = parseDescriptor(descriptor);
    const args = [];
    for (let i = 0; i < params.length; i++) {
      args.unshift(frame.stack.pop());
    }
    
    let result = jreMethod(jvm, null, args, thread);
    const { returnType } = parseDescriptor(descriptor);
    if (returnType !== 'V' && result !== undefined) {
      frame.stack.push(result);
    }
    return;
  }

  let workspaceEntry = jvm.classes[className];
  if (!workspaceEntry) {
    workspaceEntry = await jvm.loadClassByName(className);
  }
  const method = jvm.findMethod(workspaceEntry, methodName, descriptor);
  if (method) {
    const newFrame = new Frame(method);
    const { params } = parseDescriptor(descriptor);
    for (let i = params.length - 1; i >= 0; i--) {
      newFrame.locals[i] = frame.stack.pop();
    }
    thread.callStack.push(newFrame);
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

  const jreMethod = jvm._jreFindMethod(className, methodName, descriptor);

  if (jreMethod) {
      await jreMethod(jvm, obj, args);
      return;
  }

  // For user-defined methods (constructors, private methods, super calls)
    let workspaceEntry = jvm.classes[className];
    if (!workspaceEntry) {
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
      let localIndex = 0;
      newFrame.locals[localIndex++] = obj; // 'this'
      for (const arg of args) {
          newFrame.locals[localIndex++] = arg;
      }
      thread.callStack.push(newFrame);
  } else if (methodName === '<init>') {
      // If no constructor is found, it might be an empty constructor from a superclass (e.g. Object).
      // For now, we do nothing, assuming the object is already created by 'new'.
  } else {
      throw new Error(`Unsupported invokespecial: ${className}.${methodName}${descriptor}`);
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
      type: 'java/lang/Runnable',
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

  const staticArgs = bsm.arguments.map(arg => {
    if (arg.type === 'MethodHandle') {
      return new MethodHandle(arg.value.kind, arg.value.reference);
    }
    if (arg.type === 'MethodType') {
      return new MethodType(arg.value);
    }
    return arg.value;
  });

  const bsmArgs = [lookup, invokedName, invokedType, ...staticArgs];

  if (bsm.method_ref.value.reference.className === 'java/lang/invoke/StringConcatFactory') {
    const recipe = bsm.arguments[0].value;
    const { params } = parseDescriptor(nameAndType.descriptor);
    const dynamicArgs = [];
    for (let i = 0; i < params.length; i++) {
        dynamicArgs.unshift(frame.stack.pop());
    }

    let result = '';
    let argIndex = 0;
    for (let i = 0; i < recipe.length; i++) {
        const char = recipe.charAt(i);
        if (char === '\u0001') {
            const arg = dynamicArgs[argIndex++];
            // Convert Java objects to strings properly
            if (arg && typeof arg === 'object' && arg.toString) {
                result += arg.toString();
            } else if (arg && typeof arg === 'object' && arg.value !== undefined) {
                // Java String object
                result += arg.value;
            } else {
                result += String(arg);
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
  bsmArgs.forEach(arg => frame.stack.push(arg));

  // 5. Create a fake instruction to pass to the invokestatic handler.
  const bsmInstruction = {
    op: 'invokestatic',
    arg: [
      'Method',
      bsm.method_ref.value.reference.className,
      [
        bsm.method_ref.value.reference.nameAndType.name,
        bsm.method_ref.value.reference.nameAndType.descriptor
      ]
    ]
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
  if (bsm.method_ref.value.reference.className === 'java/lang/invoke/LambdaMetafactory') {
    // Create a functional interface object (e.g., Runnable).
    const runnable = {
      type: 'java/lang/Runnable', // The functional interface type
      methodHandle: targetMethodHandle, // The implementation of the interface's method
    };

    // Push the resulting functional interface object onto the stack.
    frame.stack.push(runnable);
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

  // Check for null object reference
  if (obj === null) {
    throw {
      type: 'java/lang/NullPointerException',
      message: 'Attempted to invoke interface method on null object reference'
    };
  }

  // For a functional interface with method handle (lambdas)
  if (obj.methodHandle) {
    const targetMethodHandle = obj.methodHandle;

    // Now, invoke the target method. It's a static method in this case.
    const lambdaInstruction = {
      op: 'invokestatic',
      arg: [
        'Method',
        targetMethodHandle.reference.className,
        [
          targetMethodHandle.reference.nameAndType.name,
          targetMethodHandle.reference.nameAndType.descriptor
        ]
      ]
    };

    await invokestatic(frame, lambdaInstruction, jvm, thread);
    return;
  }

  // For regular interface implementations, treat like invokevirtual
  
  // Special handling for annotation proxy objects
  if (obj._annotationData) {
    const methodKey = methodName + descriptor;
    if (typeof obj[methodKey] === 'function') {
      const result = obj[methodKey]();
      const { returnType } = parseDescriptor(descriptor);
      if (returnType !== 'V' && result !== undefined) {
        frame.stack.push(result);
      }
      return;
    }
  }
  
  // First check JRE methods
  let currentClassName = obj.type;
  while (currentClassName) {
    const jreMethod = jvm._jreFindMethod(currentClassName, methodName, descriptor);
    if (jreMethod) {
      let result = jreMethod(jvm, boxedObj, args, thread);
      if (result !== ASYNC_METHOD_SENTINEL) {
        const { returnType } = parseDescriptor(descriptor);
        if (returnType !== 'V' && result !== undefined) {
          if (typeof result === 'boolean') {
            result = result ? 1 : 0;
          }
          frame.stack.push(result);
        }
      }
      return;
    }

    let classData = jvm.classes[currentClassName];
    if (!classData) {
      classData = await jvm.loadClassByName(currentClassName);
    }

    if (classData) {
      const method = jvm.findMethod(classData, methodName, descriptor);
      if (method) {
        const newFrame = new Frame(method);
        newFrame.locals[0] = obj; // 'this'
        for (let i = 0; i < args.length; i++) {
          newFrame.locals[i+1] = args[i];
        }
        thread.callStack.push(newFrame);
        return;
      }
      currentClassName = classData.ast.classes[0].superClassName;
    } else {
      currentClassName = null;
    }
  }

  throw new Error(`Unsupported invokeinterface: ${obj.type}.${methodName}${descriptor}`);
}

const invokeHandlers = {
  invokevirtual,
  invokestatic,
  invokespecial,
  invokedynamic,
  invokeinterface,
};

module.exports = invokeHandlers;

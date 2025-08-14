const { parseDescriptor } = require('../typeParser');
const Frame = require('../frame');
const Stack = require('../stack');
const path = require('path');

module.exports = {
  invokevirtual: async (frame, instruction, jvm, thread) => {
    const [_, className, [methodName, descriptor]] = instruction.arg;
    const { params } = parseDescriptor(descriptor);
    const args = [];
    for (let i = 0; i < params.length; i++) {
      args.unshift(frame.stack.pop());
    }
    const obj = frame.stack.pop();

    if (className === 'java/lang/reflect/Method' && methodName === 'invoke') {
      console.log('Inside invoke.js special case for Method.invoke');
      const methodObj = obj;
      const obj_for_invoke = args[0];
      const args_for_invoke = args[1];

      const methodData = methodObj._methodData;
      const newFrame = new Frame(methodData);

      let localIndex = 0;
      if (!methodData.flags.includes('static')) {
        newFrame.locals[localIndex++] = obj_for_invoke;
      }
      for (let i = 0; i < args_for_invoke.length; i++) {
        newFrame.locals[localIndex++] = args_for_invoke[i];
      }

      thread.isAwaitingReflectiveCall = true;
      thread.reflectiveCallResolver = (ret) => {
        console.log('Executing reflectiveCallResolver in invoke.js, ret:', ret);
        frame.stack.push(ret);
      };
      thread.callStack.push(newFrame);
      return;
    } else if (methodName === 'start' && descriptor === '()V') {
      // Handle Thread.start()
      const threadObject = obj;
      const threadClassName = threadObject.type;

      const runMethod = jvm.findMethodInHierarchy(threadClassName, 'run', '()V');
      if (runMethod) {
        const newThread = {
          id: jvm.threads.length,
          callStack: new Stack(),
          status: 'runnable',
        };
        const newFrame = new Frame(runMethod);
        newFrame.locals[0] = threadObject; // 'this'
        newThread.callStack.push(newFrame);
        jvm.threads.push(newThread);
      } else {
        console.error(`Could not find run() method on ${threadClassName}`);
      }
      return;
    } else {
      const methodKey = `${className}.${methodName}${descriptor}`;
      const jreMethod = jvm._jreMethods[methodKey];

      if (jreMethod) {
        const result = await jreMethod(jvm, obj, args);
        const { returnType } = parseDescriptor(descriptor);
        if (returnType !== 'V') {
          frame.stack.push(result);
        }
      } else {
        // This is for user-defined instance methods.
        const method = jvm.findMethodInHierarchy(obj.type, methodName, descriptor);
        if (method) {
          const newFrame = new Frame(method);
          newFrame.locals[0] = obj; // 'this'
          for (let i = 0; i < args.length; i++) {
            newFrame.locals[i+1] = args[i];
          }
          thread.callStack.push(newFrame);
        } else {
          console.error(`Unsupported invokevirtual: ${className}.${methodName}${descriptor}`);
        }
      }
    }
  },
  invokestatic: async (frame, instruction, jvm, thread) => {
    const [_, className, [methodName, descriptor]] = instruction.arg;

    const methodKey = `${className}.${methodName}${descriptor}`;
    const jreMethod = jvm._jreMethods[methodKey];

    if (jreMethod) {
      const { params } = parseDescriptor(descriptor);
      const args = [];
      for (let i = 0; i < params.length; i++) {
        args.unshift(frame.stack.pop());
      }
      const result = await jreMethod(jvm, null, args);
      const { returnType } = parseDescriptor(descriptor);
      if (returnType !== 'V') {
        frame.stack.push(result);
      }
      return;
    }

    let classData = jvm.classes[className];
    if (!classData) {
      const newClassPath = path.join(jvm.classpath, `${className}.class`);
      classData = jvm.loadClassSync(newClassPath, { silent: true });
    }
    const method = jvm.findMethod(classData, methodName, descriptor);
    if (method) {
      const newFrame = new Frame(method);
      const { params } = parseDescriptor(descriptor);
      for (let i = params.length - 1; i >= 0; i--) {
        newFrame.locals[i] = frame.stack.pop();
      }
      thread.callStack.push(newFrame);
    }
  },
  invokespecial: async (frame, instruction, jvm, thread) => {
    const [_, className, [methodName, descriptor]] = instruction.arg;
    const { params } = parseDescriptor(descriptor);
    const args = [];
    for (let i = 0; i < params.length; i++) {
        args.unshift(frame.stack.pop());
    }
    const obj = frame.stack.pop();

    const methodKey = `${className}.${methodName}${descriptor}`;
    const jreMethod = jvm._jreMethods[methodKey];

    if (jreMethod) {
        await jreMethod(jvm, obj, args);
        return;
    }

    // For user-defined methods (constructors, private methods, super calls)
    const classData = jvm.classes[className];
    if (!classData) {
        // If class is not loaded, loading it.
        const loadedClassData = await jvm.loadClassByName(className);
        if (!loadedClassData) {
          console.error(`Class not found for invokespecial: ${className}`);
          return;
        }
    }

    const method = jvm.findMethod(jvm.classes[className], methodName, descriptor);
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
        console.error(`Unsupported invokespecial: ${className}.${methodName}${descriptor}`);
    }
  },
};

const { parseDescriptor } = require('../typeParser');
const Frame = require('../frame');
const Stack = require('../stack');

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

      thread.callStack.push(newFrame);
      return;
    }

    // Handle Thread.start()
    if (methodName === 'start' && descriptor === '()V') {
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
    }

    const methodKey = `${className}.${methodName}`;
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
  },
  invokestatic: async (frame, instruction, jvm, thread) => {
    const [_, className, [methodName, descriptor]] = instruction.arg;

    const methodKey = `${className}.${methodName}`;
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
      const newClassPath = `sources/${className}.class`;
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

    if (methodName === '<init>') {
      const methodKey = `${className}.${methodName}`;
      const jreMethod = jvm._jreMethods[methodKey];
      if (jreMethod) {
        await jreMethod(jvm, obj, args);
      } else {
        // This is a constructor for a user-defined class.
        // We need to find the constructor and invoke it.
        const method = jvm.findMethodInHierarchy(className, methodName, descriptor);
        if (method) {
          const newFrame = new Frame(method);
          newFrame.locals[0] = obj; // 'this'
          for (let i = 0; i < args.length; i++) {
            newFrame.locals[i+1] = args[i];
          }
          thread.callStack.push(newFrame);
        } else {
          // If no constructor is found, it might be an empty constructor from a superclass (e.g. Object).
          // For now, we do nothing, assuming the object is already created by 'new'.
        }
      }
    }
  },
};

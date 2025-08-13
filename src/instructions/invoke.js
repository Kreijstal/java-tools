const { parseDescriptor } = require('../typeParser');
const Frame = require('../frame');

module.exports = {
  invokevirtual: (frame, instruction, jvm) => {
    const [_, className, [methodName, descriptor]] = instruction.arg;
    const { params } = parseDescriptor(descriptor);
    const args = [];
    for (let i = 0; i < params.length; i++) {
      args.unshift(frame.stack.pop());
    }
    const obj = frame.stack.pop();

    const methodKey = `${className}.${methodName}`;
    const jreMethod = jvm._jreMethods[methodKey];

    if (jreMethod) {
      const result = jreMethod(jvm, obj, args);
      const { returnType } = parseDescriptor(descriptor);
      if (returnType !== 'V') {
        frame.stack.push(result);
      }
    } else {
      console.error(`Unsupported invokevirtual: ${className}.${methodName}${descriptor}`);
    }
  },
  invokestatic: (frame, instruction, jvm) => {
    const [_, className, [methodName, descriptor]] = instruction.arg;

    const methodKey = `${className}.${methodName}`;
    const jreMethod = jvm._jreMethods[methodKey];

    if (jreMethod) {
      const { params } = parseDescriptor(descriptor);
      const args = [];
      for (let i = 0; i < params.length; i++) {
        args.unshift(frame.stack.pop());
      }
      const result = jreMethod(jvm, null, args);
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
      jvm.callStack.push(newFrame);
    }
  },
  invokespecial: (frame, instruction, jvm) => {
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
        jreMethod(jvm, obj, args);
      }
    }
  },
};

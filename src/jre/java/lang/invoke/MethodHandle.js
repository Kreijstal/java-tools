const invokeHandlers = require('/app/src/instructions/invoke');
const objectHandlers = require('/app/src/instructions/object');

async function invokeWithArguments(jvm, handle, methodArgs) {
  const thread = jvm.threads[jvm.currentThreadIndex];
  const frame = thread.callStack.peek();
  const instruction = {
    op: handle.kind,
    arg: [
      handle.kind.endsWith('Field') ? 'Field' : 'Method',
      handle.reference.className,
      [handle.reference.nameAndType.name, handle.reference.nameAndType.descriptor],
    ],
  };

  switch (handle.kind) {
    case 'invokeVirtual':
    case 'invokeSpecial':
      frame.stack.push(methodArgs[0]);
      for (let i = 1; i < methodArgs.length; i++) {
        frame.stack.push(methodArgs[i]);
      }
      if (handle.kind === 'invokeVirtual') {
        await invokeHandlers.invokevirtual(frame, instruction, jvm, thread);
      } else {
        await invokeHandlers.invokespecial(frame, instruction, jvm, thread);
      }
      if (handle.methodType.rtype !== 'V') {
        return frame.stack.pop();
      }
      return null;
    case 'invokeStatic':
      for (const arg of methodArgs) {
        frame.stack.push(arg);
      }
      await invokeHandlers.invokestatic(frame, instruction, jvm, thread);
      if (handle.methodType.rtype !== 'V') {
        return frame.stack.pop();
      }
      return null;
    case 'getField':
      frame.stack.push(methodArgs[0]);
      await objectHandlers['getfield'](frame, instruction, jvm);
      return frame.stack.pop();
    case 'putField':
      frame.stack.push(methodArgs[0]);
      frame.stack.push(methodArgs[1]);
      await objectHandlers['putfield'](frame, instruction, jvm);
      return null;
    default:
      throw new Error(`Unsupported MethodHandle kind: ${handle.kind}`);
  }
}

module.exports = {
  super: 'java/lang/Object',
  methods: {
    'invoke(Ljava/lang/String;)V': async (jvm, handle, args) => {
      return await invokeWithArguments(jvm, handle, args);
    },
    'invoke(LMethodHandlesTest;I)Ljava/lang/String;': async (jvm, handle, args) => {
      return await invokeWithArguments(jvm, handle, args);
    },
    'invoke(LMethodHandlesTest;I)V': async (jvm, handle, args) => {
      return await invokeWithArguments(jvm, handle, args);
    },
    'invoke(LMethodHandlesTest;)I': async (jvm, handle, args) => {
      return await invokeWithArguments(jvm, handle, args);
    },
  },
};
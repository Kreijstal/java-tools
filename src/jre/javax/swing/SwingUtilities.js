const Frame = require('../../../frame');

async function createRunnableFrame(jvm, runnable) {
  if (!runnable) {
    return null;
  }

  if (runnable.methodHandle) {
    const reference = runnable.methodHandle.reference;
    const method = await jvm.findMethodInHierarchy(
      reference.className,
      reference.nameAndType.name,
      reference.nameAndType.descriptor,
    );
    if (!method) {
      return null;
    }
    const frame = new Frame(method);
    frame.className = reference.className;
    return frame;
  }

  if (!runnable.type) {
    return null;
  }

  const method = await jvm.findMethodInHierarchy(runnable.type, 'run', '()V');
  if (!method) {
    return null;
  }
  const frame = new Frame(method);
  frame.className = runnable.type;
  frame.locals[0] = runnable;
  return frame;
}

async function runOnCurrentThread(jvm, runnable, thread) {
  const targetThread = thread || jvm.threads[jvm.currentThreadIndex];
  if (!targetThread) {
    return;
  }

  const frame = await createRunnableFrame(jvm, runnable);
  if (!frame) {
    return;
  }

  const callStack = targetThread.callStack;
  const previousDepth = callStack.size();
  const previousIndex = jvm.currentThreadIndex;
  const threadIndex = jvm.threads.indexOf(targetThread);
  const previousFlag = !!targetThread.isEventDispatchThread;

  callStack.push(frame);
  targetThread.isEventDispatchThread = true;

  while (callStack.size() > previousDepth) {
    if (threadIndex !== -1) {
      jvm.currentThreadIndex = threadIndex;
    }
    const result = await jvm.executeTick();
    if (result && result.completed) {
      break;
    }
  }

  targetThread.isEventDispatchThread = previousFlag;
  jvm.currentThreadIndex = previousIndex;
}

module.exports = {
  super: 'java/lang/Object',
  staticMethods: {
    'invokeLater(Ljava/lang/Runnable;)V': async (jvm, clazz, args, thread) => {
      const runnable = args[0];
      await runOnCurrentThread(jvm, runnable, thread);
    },

    'invokeAndWait(Ljava/lang/Runnable;)V': async (jvm, clazz, args, thread) => {
      const runnable = args[0];
      await runOnCurrentThread(jvm, runnable, thread);
    },

    'isEventDispatchThread()Z': (jvm, clazz, args, thread) => {
      if (thread && thread.isEventDispatchThread) {
        return 1;
      }
      const current = jvm.threads[jvm.currentThreadIndex];
      return current && current.isEventDispatchThread ? 1 : 0;
    },
  },
};

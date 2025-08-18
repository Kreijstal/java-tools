const { ASYNC_METHOD_SENTINEL } = require('../../../constants');

module.exports = {
  super: 'java/lang/Object',
  staticFields: {},
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.hashCode = jvm.nextHashCode++;
      delete obj.isUninitialized;
    },
    '<init>(Ljava/lang/Runnable;)V': (jvm, obj, args) => {
      obj.hashCode = jvm.nextHashCode++;
      obj.runnable = args[0];
      delete obj.isUninitialized;
    },
    'start()V': async (jvm, threadObject, args, currentThread) => {
      const Stack = require('../../../stack');
      const Frame = require('../../../frame');
      const target = threadObject.runnable || threadObject;
      const targetClassName = target.type;

      const runMethod = await jvm.findMethodInHierarchy(targetClassName, 'run', '()V');
      if (runMethod) {
        const newThread = {
          id: jvm.threads.length,
          callStack: new Stack(),
          status: 'runnable',
        };
        threadObject.nativeThread = newThread;
        const newFrame = new Frame(runMethod);
        newFrame.locals[0] = target; // 'this'
        newThread.callStack.push(newFrame);
        jvm.threads.push(newThread);
      } else {
        console.error(`Could not find run() method on ${targetClassName}`);
      }
      return ASYNC_METHOD_SENTINEL;
    },
    'join()V': (jvm, obj, args, thread) => {
      const threadToJoin = obj.nativeThread;
      if (!threadToJoin || threadToJoin.status === 'terminated') {
        return;
      }

      thread.status = 'JOINING';
      thread.joiningOn = threadToJoin;
    },
    'sleep(J)V': (jvm, obj, args, thread) => {
      const time = args[0];
      thread.status = 'SLEEPING';
      thread.sleepUntil = Date.now() + Number(time);
    },
  },
};

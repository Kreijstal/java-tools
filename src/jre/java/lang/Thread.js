const { ASYNC_METHOD_SENTINEL } = require('../../../constants');

module.exports = {
  super: 'java/lang/Object',
  interfaces: ['java/lang/Runnable'],
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

      const newThread = {
        id: jvm.threads.length,
        callStack: new Stack(),
        status: 'runnable',
      };
      threadObject.nativeThread = newThread;
      
      // Handle lambda Runnables (created by invokedynamic)
      if (target.methodHandle) {
        // This is a lambda - create invokestatic instruction to call the lambda method
        const lambdaInstruction = {
          op: 'invokestatic',
          arg: [
            'Method',
            target.methodHandle.reference.className,
            [
              target.methodHandle.reference.nameAndType.name,
              target.methodHandle.reference.nameAndType.descriptor
            ]
          ]
        };
        
        // Create a frame for the lambda method call
        const lambdaMethod = await jvm.findMethodInHierarchy(
          target.methodHandle.reference.className,
          target.methodHandle.reference.nameAndType.name,
          target.methodHandle.reference.nameAndType.descriptor
        );
        
        if (lambdaMethod) {
          const newFrame = new Frame(lambdaMethod);
          // Lambda methods are static, so no 'this' parameter needed
          newThread.callStack.push(newFrame);
          jvm.threads.push(newThread);
        } else {
          console.error(`Could not find lambda method: ${target.methodHandle.reference.className}.${target.methodHandle.reference.nameAndType.name}`);
        }
      } else {
        // Handle regular Runnable implementations or Thread subclasses
        const targetClassName = target.type;
        const runMethod = await jvm.findMethodInHierarchy(targetClassName, 'run', '()V');
        if (runMethod) {
          const newFrame = new Frame(runMethod);
          newFrame.locals[0] = target; // 'this'
          newThread.callStack.push(newFrame);
          jvm.threads.push(newThread);
        } else {
          // If no run method found and no runnable, it's Thread's default run (no-op)
          if (!threadObject.runnable) {
            // Thread's default run() method does nothing - terminate immediately
            newThread.status = 'terminated';
            jvm.threads.push(newThread);
          } else {
            console.error(`Could not find run() method on ${targetClassName}`);
          }
        }
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

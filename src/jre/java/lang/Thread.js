const { ASYNC_METHOD_SENTINEL } = require('../../../core/constants');
const { withThrows } = require('../../helpers');

function stringValue(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }
  return value.valueOf ? String(value.valueOf()) : String(value);
}

function addThreadToGroup(group, threadObject) {
  if (!group.threads) group.threads = [];
  if (!group.threads.includes(threadObject)) group.threads.push(threadObject);
}

function ensureJavaThread(jvm, internalThread) {
  if (!internalThread.javaThread) {
    internalThread.javaThread = {
      type: 'java/lang/Thread',
      name: internalThread.name || 'Unknown',
      nativeThread: internalThread,
      hashCode: jvm.nextHashCode++,
    };
  }
  if (!internalThread.javaThread.threadGroup) {
    const group = internalThread.threadGroup || {
      type: 'java/lang/ThreadGroup',
      name: jvm.internString('system'),
      parent: null,
      threads: [],
    };
    internalThread.threadGroup = group;
    internalThread.javaThread.threadGroup = group;
  }
  addThreadToGroup(internalThread.javaThread.threadGroup,
    internalThread.javaThread);
  return internalThread.javaThread;
}

function initializeThread(jvm, obj, { runnable = null, name = null } = {},
    currentThread = null) {
  obj.hashCode = jvm.nextHashCode++;
  obj.name = name || `Thread-${obj.hashCode}`;
  obj.runnable = runnable;
  obj.daemon = false;
  obj.priority = 5;
  if (currentThread) {
    obj.threadGroup = ensureJavaThread(jvm, currentThread).threadGroup;
  }
  delete obj.isUninitialized;
}

module.exports = {
  super: 'java/lang/Object',
  interfaces: ['java/lang/Runnable'],
  staticFields: {},
  staticMethods: {
    'currentThread()Ljava/lang/Thread;': (jvm, obj, args) => {
      const internalThread = jvm.threads[jvm.currentThreadIndex];
      return ensureJavaThread(jvm, internalThread);
    }
  },
  methods: {
    '<init>()V': (jvm, obj, args, currentThread) => {
      initializeThread(jvm, obj, {}, currentThread);
    },
    '<init>(Ljava/lang/Runnable;)V': (jvm, obj, args, currentThread) => {
      initializeThread(jvm, obj, { runnable: args[0] }, currentThread);
    },
    '<init>(Ljava/lang/String;)V': (jvm, obj, args, currentThread) => {
      initializeThread(jvm, obj, { name: stringValue(args[0], null) },
        currentThread);
    },
    '<init>(Ljava/lang/Runnable;Ljava/lang/String;)V':
        (jvm, obj, args, currentThread) => {
      initializeThread(jvm, obj, {
        runnable: args[0],
        name: stringValue(args[1], null),
      }, currentThread);
    },
    'setDaemon(Z)V': (jvm, obj, args) => {
      obj.daemon = args[0];
    },
    'setPriority(I)V': (jvm, obj, args) => {
      obj.priority = args[0];
    },
    'getName()Ljava/lang/String;': (jvm, obj, args) => {
      return jvm.internString(obj.name);
    },
    'getThreadGroup()Ljava/lang/ThreadGroup;': (jvm, obj) =>
      obj.threadGroup || null,
    'start()V': async (jvm, threadObject, args, currentThread) => {
      const Stack = require('../../../core/stack');
      const Frame = require('../../../core/frame');
      const target = threadObject.runnable || threadObject;

      const newThread = {
        id: jvm.threads.length,
        callStack: new Stack(),
        status: 'runnable',
        javaThread: threadObject,
      };
      threadObject.nativeThread = newThread;
      if (threadObject.threadGroup) {
        newThread.threadGroup = threadObject.threadGroup;
        addThreadToGroup(threadObject.threadGroup, threadObject);
      }
      
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
          newFrame.className = target.methodHandle.reference.className; // Add className to the frame
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
          newFrame.className = targetClassName; // Add className to the frame
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
    'join()V': withThrows((jvm, obj, args, thread) => {
      const threadToJoin = obj.nativeThread;
      if (!threadToJoin || threadToJoin.status === 'terminated') {
        return;
      }

      thread.status = 'JOINING';
      thread.joiningOn = threadToJoin;
    }, ['java/lang/InterruptedException']),
    'sleep(J)V': withThrows((jvm, obj, args, thread) => {
      const time = args[0];
      thread.status = 'SLEEPING';
      thread.sleepUntil = jvm.clock.millis() + Number(time);
    }, ['java/lang/InterruptedException']),
    'interrupt()V': (jvm, obj, args) => {
      obj.interrupted = true;
      if (obj.nativeThread && obj.nativeThread.status === 'SLEEPING') {
        obj.nativeThread.status = 'runnable';
        delete obj.nativeThread.sleepUntil;
      }
    },
  },
};

module.exports.ensureJavaThread = ensureJavaThread;

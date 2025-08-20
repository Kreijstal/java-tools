module.exports = {
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj._isLocked = false;
      obj._waitingThreads = [];
    },
    'lock()V': (jvm, obj, args, thread) => {
      if (obj._isLocked) {
        thread.status = 'BLOCKED';
        thread.blockingOn = obj;
        obj._waitingThreads.push(thread);
        // Decrement PC to re-execute the lock instruction
        const frame = thread.callStack.peek();
        frame.pc--;
      } else {
        obj._isLocked = true;
      }
    },
    'unlock()V': (jvm, obj, args) => {
      obj._isLocked = false;
      // Wake up all waiting threads
      for (const waitingThread of obj._waitingThreads) {
        if (waitingThread.blockingOn === obj) {
          waitingThread.status = 'runnable';
          delete waitingThread.blockingOn;
        }
      }
      obj._waitingThreads = [];
    },
  },
};

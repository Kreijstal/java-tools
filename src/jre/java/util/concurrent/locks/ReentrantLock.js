module.exports = {
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj._isReentrantLock = true; // Marker property
      obj.isLocked = false;
      obj.waitingThreads = [];
      obj.ownerThread = null;
      obj.lockCount = 0;
    },
    'lock()V': (jvm, obj, args, thread) => {
      if (obj.isLocked && obj.ownerThread !== thread) {
        thread.status = 'BLOCKED';
        thread.blockingOn = obj;
        if (!obj.waitingThreads.includes(thread)) {
            obj.waitingThreads.push(thread);
        }
        // Decrement PC to re-execute the lock instruction
        const frame = thread.callStack.peek();
        if (frame) {
            frame.pc--;
        }
      } else {
        obj.isLocked = true;
        obj.ownerThread = thread;
        obj.lockCount++;
      }
    },
    'unlock()V': (jvm, obj, args, thread) => {
      if (obj.ownerThread !== thread) {
        // In a real JVM, this would throw IllegalMonitorStateException.
        return;
      }

      obj.lockCount--;
      if (obj.lockCount === 0) {
        obj.isLocked = false;
        obj.ownerThread = null;
        if (obj.waitingThreads.length > 0) {
          const nextThread = obj.waitingThreads.shift();
          nextThread.status = 'runnable';
          delete nextThread.blockingOn;
        }
      }
    },
  },
};

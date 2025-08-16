module.exports = {
  super: null,
  staticFields: {},
  methods: {
    'getClass()Ljava/lang/Class;': (jvm, obj, args) => {
      const className = obj.type;
      const classData = jvm.classes[className];
      return {
        type: 'java/lang/Class',
        _classData: classData,
      };
    },
    'hashCode()I': (jvm, obj, args) => {
      return obj.hashCode;
    },
    'equals(Ljava/lang/Object;)Z': (jvm, obj, args) => {
      const other = args[0];
      return obj === other ? 1 : 0;
    },
    'toString()Ljava/lang/String;': (jvm, obj, args) => {
      const className = obj.type.replace(/\//g, '.');
      const hashCode = obj.hashCode.toString(16);
      return jvm.internString(`${className}@${hashCode}`);
    },

    'wait()V': (jvm, obj, args, thread) => {
      if (obj.lockOwner !== thread.id) {
        // This should throw IllegalMonitorStateException
        console.error("IllegalMonitorStateException: thread does not own the monitor for wait()");
        return;
      }

      // Add to wait set
      if (!obj.waitSet.includes(thread)) {
        obj.waitSet.push(thread);
      }

      // Store lock count and release monitor
      // A thread waiting should release all its locks on the object.
      const lockCount = obj.lockCount;
      obj.lockCount = 0;
      obj.lockOwner = null;
      thread.savedLockCount = lockCount; // Save it for re-acquisition.

      thread.status = 'WAITING';

      // Wake up a thread waiting to ENTER the monitor, since we just freed it.
      const nextThread = obj.monitorQueue.shift();
      if (nextThread) {
        nextThread.status = 'RUNNABLE';
      }
    },

    'notify()V': (jvm, obj, args, thread) => {
      if (obj.lockOwner !== thread.id) {
        // This should throw IllegalMonitorStateException
        console.error("IllegalMonitorStateException: thread does not own the monitor for notify()");
        return;
      }

      const waitingThread = obj.waitSet.shift();
      if (waitingThread) {
        // This thread is no longer waiting. It is now blocked, waiting to re-acquire the monitor.
        waitingThread.status = 'BLOCKED';
        if (!obj.monitorQueue.includes(waitingThread)) {
          obj.monitorQueue.push(waitingThread);
        }
      }
    },
  },
};

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
    'clone()Ljava/lang/Object;': (jvm, obj, args) => {
      // Handle array cloning
      if (obj.type && obj.type.startsWith('[')) {
        const cloned = [...obj]; // Shallow copy of array elements
        cloned.type = obj.type;
        cloned.elementType = obj.elementType;
        cloned.length = obj.length;
        cloned.hashCode = jvm.nextHashCode++;
        return cloned;
      }
      
      // Basic clone implementation - shallow copy
      const cloned = Object.assign({}, obj);
      cloned.hashCode = jvm.nextHashCode++;
      return cloned;
    },
    'wait()V': (jvm, obj, args, thread) => {
      if (obj.lockOwner !== thread.id) {
        // In a real implementation, this would throw IllegalMonitorStateException.
        console.error(`Thread ${thread.id} attempted to wait on a monitor it does not own.`);
        return;
      }

      // 1. Add the current thread to the object's wait set.
      obj.waitSet.push(thread);

      // 2. Change the thread's status to WAITING.
      thread.status = 'WAITING';

      // 3. Atomically release the lock.
      // We must also remember how many times the lock was held recursively.
      const lockCount = obj.lockCount;
      obj.isLocked = false;
      obj.lockOwner = null;
      obj.lockCount = 0;

      // Store the lock count so it can be restored when the thread wakes up.
      thread.waitLockCount = lockCount;

      // The JVM scheduler will now be able to run another thread that might have been
      // BLOCKED on this object's monitor.
    },
    'wait(J)V': (jvm, obj, args, thread) => {
      // Implementation for wait with timeout (milliseconds)
      const timeout = args[0]; // BigInt or number
      
      if (obj.lockOwner !== thread.id) {
        throw {
          type: 'java/lang/IllegalMonitorStateException',
          message: 'current thread not owner',
        };
      }
      
      // For simplicity, treat timed wait same as regular wait in this mock implementation
      // In a real JVM, this would involve timers and timeout handling
      const waitMethod = obj.methods ? obj.methods['wait()V'] : module.exports.methods['wait()V'];
      if (waitMethod) {
        waitMethod(jvm, obj, [], thread);
      }
    },
    'wait(JI)V': (jvm, obj, args, thread) => {
      // Implementation for wait with timeout (milliseconds) and nanos  
      const timeout = args[0]; // BigInt or number - milliseconds
      const nanos = args[1]; // int - nanoseconds
      
      if (obj.lockOwner !== thread.id) {
        throw {
          type: 'java/lang/IllegalMonitorStateException',
          message: 'current thread not owner',
        };
      }
      
      // For simplicity, treat timed wait same as regular wait in this mock implementation
      // In a real JVM, this would involve precise timing with milliseconds + nanoseconds
      const waitMethod = obj.methods ? obj.methods['wait()V'] : module.exports.methods['wait()V'];
      if (waitMethod) {
        waitMethod(jvm, obj, [], thread);
      }
    },
    'notify()V': (jvm, obj, args, thread) => {
      if (obj.lockOwner !== thread.id) {
        throw {
          type: 'java/lang/IllegalMonitorStateException',
          message: 'current thread not owner',
        };
      }
      if (obj.waitSet.length > 0) {
        const notifiedThread = obj.waitSet.shift();
        notifiedThread.status = 'BLOCKED';
        notifiedThread.blockingOn = obj;
      }
    },
    'notifyAll()V': (jvm, obj, args, thread) => {
      if (obj.lockOwner !== thread.id) {
        throw {
          type: 'java/lang/IllegalMonitorStateException',
          message: 'current thread not owner',
        };
      }
      while (obj.waitSet.length > 0) {
        const notifiedThread = obj.waitSet.shift();
        notifiedThread.status = 'BLOCKED';
        notifiedThread.blockingOn = obj;
      }
    },
  },
};

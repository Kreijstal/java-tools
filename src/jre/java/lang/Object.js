module.exports = {
  'java/lang/Object.getClass()Ljava/lang/Class;': (jvm, obj, args) => {
    const className = obj.type;
    const classData = jvm.classes[className];
    return {
      type: 'java/lang/Class',
      _classData: classData,
    };
  },

  'java/lang/Object.hashCode()I': (jvm, obj, args) => {
    return obj.hashCode;
  },

  'java/lang/Object.equals(Ljava/lang/Object;)Z': (jvm, obj, args) => {
    const other = args[0];
    return obj === other ? 1 : 0;
  },

  'java/lang/Object.toString()Ljava/lang/String;': (jvm, obj, args) => {
    const className = obj.type.replace(/\//g, '.');
    const hashCode = obj.hashCode.toString(16);
    return jvm.internString(`${className}@${hashCode}`);
  },

  'java/lang/Object.wait()V': (jvm, obj, args, thread) => {
    if (obj.lockOwner !== thread.id) {
      // This should throw IllegalMonitorStateException
      return;
    }
    obj.waitSet.push(thread);
    thread.status = 'WAITING';
    obj.lockOwner = null;
    obj.lockCount = 0;
  },

  'java/lang/Object.notify()V': (jvm, obj, args, thread) => {
    if (obj.lockOwner !== thread.id) {
      // This should throw IllegalMonitorStateException
      return;
    }
    const waitingThread = obj.waitSet.shift();
    if (waitingThread) {
      waitingThread.status = 'RUNNABLE';
    }
  },

  'java/lang/Object.notifyAll()V': (jvm, obj, args, thread) => {
    if (obj.lockOwner !== thread.id) {
      // This should throw IllegalMonitorStateException
      return;
    }
    for (const waitingThread of obj.waitSet) {
      waitingThread.status = 'RUNNABLE';
    }
    obj.waitSet = [];
  },
};

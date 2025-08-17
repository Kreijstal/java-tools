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
        // TODO: throw IllegalMonitorStateException
        return;
      }

      // Add to wait set
      obj.waitSet.push(thread);
      thread.status = 'WAITING';

      // Release lock
      obj.lockOwner = null;
      obj.lockCount = 0;

      // Wake up a thread that is blocked on this object
      const blockedThread = jvm.threads.find(t => t.status === 'BLOCKED' && t.blockingOn === obj);
      if (blockedThread) {
        blockedThread.status = 'RUNNABLE';
        delete blockedThread.blockingOn;
      }
    },
    'notify()V': (jvm, obj, args, thread) => {
      if (obj.lockOwner !== thread.id) {
        // TODO: throw IllegalMonitorStateException
        return;
      }
      if (obj.waitSet.length > 0) {
        const notifiedThread = obj.waitSet.shift();
        notifiedThread.status = 'BLOCKED';
        notifiedThread.blockingOn = obj;
      }
    },
  },
};

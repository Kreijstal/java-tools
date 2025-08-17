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
    'start()V': (jvm, obj, args) => {
      // The logic for starting a new thread is handled in invokevirtual
      // instruction. This is just a placeholder.
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

module.exports = {
  super: 'java/lang/Object',
  interfaces: [
    'java/util/concurrent/locks/ReadWriteLock',
    'java/util/concurrent/locks/Lock',
  ],
  methods: {
    '<init>()V': (jvm, obj) => {
      obj['java/util/concurrent/locks/ReentrantReadWriteLock/readHolds'] = 0;
      obj['java/util/concurrent/locks/ReentrantReadWriteLock/writeHolds'] = 0;
    },
    'readLock()Ljava/util/concurrent/locks/Lock;': (jvm, obj) => {
      obj['java/util/concurrent/locks/ReentrantReadWriteLock/mode'] = 'read';
      return obj;
    },
    'writeLock()Ljava/util/concurrent/locks/Lock;': (jvm, obj) => {
      obj['java/util/concurrent/locks/ReentrantReadWriteLock/mode'] = 'write';
      return obj;
    },
    'lock()V': (jvm, obj) => {
      const mode = obj['java/util/concurrent/locks/ReentrantReadWriteLock/mode'] || 'write';
      const key = `java/util/concurrent/locks/ReentrantReadWriteLock/${mode}Holds`;
      obj[key] = (obj[key] || 0) + 1;
    },
    'unlock()V': (jvm, obj) => {
      const mode = obj['java/util/concurrent/locks/ReentrantReadWriteLock/mode'] || 'write';
      const key = `java/util/concurrent/locks/ReentrantReadWriteLock/${mode}Holds`;
      if ((obj[key] || 0) === 0) {
        throw {
          type: 'java/lang/IllegalMonitorStateException',
          message: 'Attempted to unlock an unheld lock',
        };
      }
      obj[key] -= 1;
    },
  },
};

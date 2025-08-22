'use strict';
const os = require('os');
const process = require('process');
const v8 = require('v8');

module.exports = {
  super: 'java/lang/Object',
  staticMethods: {
    'getRuntime()Ljava/lang/Runtime;': (jvm, _) => {
      const runtimeClass = jvm.classes['java/lang/Runtime'];
      return runtimeClass.staticFields.get('currentRuntime:Ljava/lang/Runtime;');
    },
    '<clinit>()V': (jvm, _) => {
      const runtimeClass = jvm.classes['java/lang/Runtime'];
      const runtimeObj = {
        type: 'java/lang/Runtime',
        fields: new Map()
      };
      runtimeClass.staticFields.set('currentRuntime:Ljava/lang/Runtime;', runtimeObj);
    }
  },
  methods: {
    'availableProcessors()I': (jvm, _, args) => {
      return os.cpus().length;
    },

    'freeMemory()J': (jvm, _, args) => {
      const memUsage = process.memoryUsage();
      return memUsage.heapTotal - memUsage.heapUsed;
    },

    'totalMemory()J': (jvm, _, args) => {
      return process.memoryUsage().heapTotal;
    },

    'maxMemory()J': (jvm, _, args) => {
      return v8.getHeapStatistics().heap_size_limit;
    },

    'exit(I)V': (jvm, _, args) => {
      // no-op
    },

    'exec(Ljava/lang/String;)Ljava/lang/Process;': (jvm, _, args) => {
      const processObj = {
        type: 'java/lang/Process',
        fields: new Map()
      };
      return processObj;
    }
  }
};

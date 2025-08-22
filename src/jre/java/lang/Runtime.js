'use strict';

// Browser-compatible module loading with fallbacks
let os, process, v8;

try {
  // Only import Node.js modules if we're in Node.js environment
  if (typeof require !== 'undefined') {
    os = require('os');
    process = require('process');
    v8 = require('v8');
  }
} catch (e) {
  // Browser environment - modules not available
  os = null;
  process = null;
  v8 = null;
}

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
      // Browser fallback: return a reasonable default of 4 cores
      if (!os || typeof os.cpus !== 'function') {
        return 4;
      }
      return os.cpus().length;
    },

    'freeMemory()J': (jvm, _, args) => {
      // Browser fallback: return a reasonable estimate (64MB free)
      if (!process || typeof process.memoryUsage !== 'function') {
        return 64 * 1024 * 1024; // 64MB
      }
      const memUsage = process.memoryUsage();
      return memUsage.heapTotal - memUsage.heapUsed;
    },

    'totalMemory()J': (jvm, _, args) => {
      // Browser fallback: return a reasonable estimate (128MB total)
      if (!process || typeof process.memoryUsage !== 'function') {
        return 128 * 1024 * 1024; // 128MB
      }
      return process.memoryUsage().heapTotal;
    },

    'maxMemory()J': (jvm, _, args) => {
      // Browser fallback: return a reasonable estimate (2GB max)
      if (!v8 || typeof v8.getHeapStatistics !== 'function') {
        return 2 * 1024 * 1024 * 1024; // 2GB
      }
      return v8.getHeapStatistics().heap_size_limit;
    },

    'exit(I)V': (jvm, _, args) => {
      // no-op in both environments - don't actually exit the process
    },

    'exec(Ljava/lang/String;)Ljava/lang/Process;': (jvm, _, args) => {
      // Return a mock Process object in both environments
      const processObj = {
        type: 'java/lang/Process',
        fields: new Map()
      };
      return processObj;
    }
  }
};

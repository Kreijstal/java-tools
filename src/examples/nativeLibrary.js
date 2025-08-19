/**
 * Example native library for JVM.js
 * 
 * This demonstrates how to create a native library that can be loaded
 * into the JVM and provide native method implementations.
 */

const mathLibrary = {
  name: 'MathLib',
  version: '1.0.0',
  description: 'Native math operations library',

  // Native method implementations
  nativeMethods: {
    'com/example/MathUtils': {
      // Fast integer square root using Newton's method
      'isqrt(I)I': (jniEnv, thisObj, args) => {
        const n = args[0];
        if (n < 0) {
          jniEnv.throwException('java/lang/IllegalArgumentException', 'Negative input');
          return 0;
        }
        if (n === 0) return 0;
        
        let x = n;
        let y = Math.floor((x + 1) / 2);
        while (y < x) {
          x = y;
          y = Math.floor((x + Math.floor(n / x)) / 2);
        }
        return x;
      },

      // Fibonacci calculation (recursive native implementation)
      'fibonacci(I)J': (jniEnv, thisObj, args) => {
        const n = args[0];
        if (n < 0) {
          jniEnv.throwException('java/lang/IllegalArgumentException', 'Negative input');
          return 0;
        }
        
        const fib = (num) => {
          if (num <= 1) return num;
          return fib(num - 1) + fib(num - 2);
        };
        
        return fib(n);
      },

      // Check if a number is prime (native optimization)
      'isPrime(I)Z': (jniEnv, thisObj, args) => {
        const n = args[0];
        if (n <= 1) return false;
        if (n <= 3) return true;
        if (n % 2 === 0 || n % 3 === 0) return false;
        
        for (let i = 5; i * i <= n; i += 6) {
          if (n % i === 0 || n % (i + 2) === 0) {
            return false;
          }
        }
        return true;
      }
    },

    'com/example/StringUtils': {
      // Native string reversal
      'reverse(Ljava/lang/String;)Ljava/lang/String;': (jniEnv, thisObj, args) => {
        const str = args[0].toString();
        const reversed = str.split('').reverse().join('');
        return jniEnv.internString(reversed);
      },

      // Count character occurrences
      'countChar(Ljava/lang/String;C)I': (jniEnv, thisObj, args) => {
        const str = args[0].toString();
        const char = String.fromCharCode(args[1]);
        let count = 0;
        for (let i = 0; i < str.length; i++) {
          if (str[i] === char) count++;
        }
        return count;
      }
    },

    'com/example/SystemUtils': {
      // Get system information
      'getSystemInfo()Ljava/lang/String;': (jniEnv, thisObj, args) => {
        const info = {
          platform: process.platform,
          arch: process.arch,
          nodeVersion: process.version,
          pid: process.pid,
          uptime: process.uptime()
        };
        return jniEnv.internString(JSON.stringify(info, null, 2));
      },

      // Get memory usage
      'getMemoryUsage()J': (jniEnv, thisObj, args) => {
        const memUsage = process.memoryUsage();
        return memUsage.heapUsed;
      },

      // Native sleep implementation  
      'sleep(I)V': (jniEnv, thisObj, args) => {
        const milliseconds = args[0];
        const start = Date.now();
        while (Date.now() - start < milliseconds) {
          // Busy wait (in real implementation, you'd use proper async/await)
        }
      }
    }
  }
};

module.exports = mathLibrary;
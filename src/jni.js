const fs = require('fs');
const path = require('path');

/**
 * Java Native Interface (JNI) implementation for the JavaScript JVM
 * 
 * This module provides a native method registry and interface that allows
 * Java code to call native implementations while staying within the Node.js runtime.
 * The interface is designed to be compatible with potential future FFI integration.
 */
class JNI {
  constructor(jvm) {
    this.jvm = jvm;
    this.nativeRegistry = new Map(); // className:methodName:descriptor -> native function
    this.nativeLibraries = new Map(); // library name -> library object
    this.verbose = false;
    
    // Initialize with built-in JRE native methods
    this._initializeBuiltinNatives();
  }

  /**
   * Register a native method implementation
   * @param {string} className - Java class name (e.g., 'java/lang/System')
   * @param {string} methodName - Method name
   * @param {string} descriptor - Method descriptor (e.g., '()V')
   * @param {function} implementation - Native implementation function
   * @param {object} options - Additional options like signature validation
   */
  registerNativeMethod(className, methodName, descriptor, implementation, options = {}) {
    const key = this._createMethodKey(className, methodName, descriptor);
    
    if (this.verbose) {
      console.log(`JNI: Registering native method ${key}`);
    }

    // Validate method signature if requested
    if (options.validateSignature) {
      this._validateMethodSignature(implementation, descriptor);
    }

    // Wrap the implementation to provide JNI environment
    const wrappedImplementation = this._wrapNativeMethod(implementation, className, methodName, descriptor);
    
    this.nativeRegistry.set(key, wrappedImplementation);
  }

  /**
   * Load a native library (JavaScript module)
   * @param {string} libraryName - Name of the library
   * @param {string|object} libraryPath - Path to JS module or library object
   * @param {object} options - Loading options
   */
  loadLibrary(libraryName, libraryPath, options = {}) {
    try {
      let library;
      
      if (typeof libraryPath === 'string') {
        // Load from file path
        const fullPath = path.resolve(libraryPath);
        if (!fs.existsSync(fullPath)) {
          throw new Error(`Native library not found: ${fullPath}`);
        }
        library = require(fullPath);
      } else {
        // Direct library object
        library = libraryPath;
      }

      // Store library reference
      this.nativeLibraries.set(libraryName, library);
      
      // Auto-register native methods if library provides them
      if (library.nativeMethods) {
        this._registerLibraryMethods(library.nativeMethods);
      }

      if (this.verbose) {
        console.log(`JNI: Loaded native library ${libraryName}`);
      }

      return library;
    } catch (error) {
      throw new Error(`Failed to load native library ${libraryName}: ${error.message}`);
    }
  }

  /**
   * Find a native method implementation
   * @param {string} className - Java class name
   * @param {string} methodName - Method name
   * @param {string} descriptor - Method descriptor
   * @returns {function|null} - Native method implementation or null
   */
  findNativeMethod(className, methodName, descriptor) {
    const key = this._createMethodKey(className, methodName, descriptor);
    return this.nativeRegistry.get(key) || null;
  }

  /**
   * Check if a method is registered as native
   * @param {string} className - Java class name
   * @param {string} methodName - Method name
   * @param {string} descriptor - Method descriptor
   * @returns {boolean}
   */
  hasNativeMethod(className, methodName, descriptor) {
    const key = this._createMethodKey(className, methodName, descriptor);
    return this.nativeRegistry.has(key);
  }

  /**
   * Get all registered native methods for a class
   * @param {string} className - Java class name
   * @returns {Array} - Array of method descriptors
   */
  getClassNativeMethods(className) {
    const methods = [];
    for (const [key, _] of this.nativeRegistry) {
      if (key.startsWith(className + ':')) {
        const parts = key.split(':');
        methods.push({
          className: parts[0],
          methodName: parts[1],
          descriptor: parts[2]
        });
      }
    }
    return methods;
  }

  /**
   * Create a method key for registry lookup
   * @private
   */
  _createMethodKey(className, methodName, descriptor) {
    return `${className}:${methodName}:${descriptor}`;
  }

  /**
   * Wrap native method to provide JNI environment
   * @private
   */
  _wrapNativeMethod(implementation, className, methodName, descriptor) {
    return (jvm, thisObj, args, thread) => {
      // Create JNI environment object
      const jniEnv = {
        jvm,
        className,
        methodName,
        descriptor,
        // Utility methods for native code
        internString: (str) => jvm.internString(str),
        createObject: (type, data) => ({ type, ...data }),
        getClass: (obj) => obj.type,
        throwException: (exceptionClass, message) => {
          throw { type: exceptionClass, message };
        }
      };

      // Call the native implementation with JNI environment
      try {
        return implementation.call(null, jniEnv, thisObj, args, thread);
      } catch (error) {
        if (this.verbose) {
          console.error(`JNI: Error in native method ${className}.${methodName}: ${error.message}`);
        }
        throw error;
      }
    };
  }

  /**
   * Initialize built-in JRE native methods by migrating existing implementations
   * @private
   */
  _initializeBuiltinNatives() {
    // Register built-in JRE methods as native implementations
    // This maintains backward compatibility while using the new JNI system
    
    // System native methods
    this.registerNativeMethod('java/lang/System', 'currentTimeMillis', '()J', 
      (jniEnv) => Date.now());
    
    this.registerNativeMethod('java/lang/System', 'nanoTime', '()J', 
      (jniEnv) => process.hrtime.bigint ? Number(process.hrtime.bigint()) : Date.now() * 1000000);

    // Object native methods  
    this.registerNativeMethod('java/lang/Object', 'hashCode', '()I',
      (jniEnv, thisObj) => {
        if (!thisObj._hashCode) {
          thisObj._hashCode = jniEnv.jvm.nextHashCode++;
        }
        return thisObj._hashCode;
      });

    this.registerNativeMethod('java/lang/Object', 'getClass', '()Ljava/lang/Class;',
      (jniEnv, thisObj) => {
        const className = thisObj.type;
        const classData = jniEnv.jvm.classes[className];
        return {
          type: 'java/lang/Class',
          _classData: classData,
          className: className
        };
      });

    // Thread native methods
    this.registerNativeMethod('java/lang/Thread', 'currentThread', '()Ljava/lang/Thread;',
      (jniEnv) => {
        const currentThread = jniEnv.jvm.threads[jniEnv.jvm.currentThreadIndex];
        return {
          type: 'java/lang/Thread',
          nativeThread: currentThread,
          id: currentThread.id
        };
      });

    if (this.verbose) {
      console.log('JNI: Initialized built-in native methods');
    }
  }

  /**
   * Register methods from a library's native method definition
   * @private
   */
  _registerLibraryMethods(nativeMethods) {
    for (const className in nativeMethods) {
      const classMethods = nativeMethods[className];
      for (const methodSignature in classMethods) {
        // Parse method signature to extract name and descriptor
        const openParen = methodSignature.indexOf('(');
        if (openParen === -1) {
          console.warn(`JNI: Invalid method signature format: ${methodSignature}`);
          continue;
        }
        
        const methodName = methodSignature.substring(0, openParen);
        const descriptor = methodSignature.substring(openParen);
        
        this.registerNativeMethod(className, methodName, descriptor, classMethods[methodSignature]);
      }
    }
  }

  /**
   * Basic method signature validation (can be enhanced)
   * @private
   */
  _validateMethodSignature(implementation, descriptor) {
    // Basic validation - can be enhanced with more sophisticated checks
    if (typeof implementation !== 'function') {
      throw new Error('Native method implementation must be a function');
    }
    
    // Parse descriptor to get parameter count (basic validation)
    const params = this._parseMethodDescriptor(descriptor);
    // Note: We can't easily validate parameter count in JavaScript due to variadic nature
    // This is a placeholder for future enhancement
  }

  /**
   * Parse method descriptor to extract parameter types
   * @private
   */
  _parseMethodDescriptor(descriptor) {
    // This is a simplified parser - the full implementation would be more complex
    const match = descriptor.match(/^\((.*)\)(.*)$/);
    if (!match) {
      throw new Error(`Invalid method descriptor: ${descriptor}`);
    }
    
    const paramString = match[1];
    const returnType = match[2];
    
    // Simple parameter parsing (could be enhanced)
    const params = [];
    let i = 0;
    while (i < paramString.length) {
      const char = paramString[i];
      if (char === 'L') {
        // Object type - find the semicolon
        const semicolon = paramString.indexOf(';', i);
        if (semicolon === -1) {
          throw new Error(`Invalid object type in descriptor: ${descriptor}`);
        }
        params.push(paramString.substring(i, semicolon + 1));
        i = semicolon + 1;
      } else if (char === '[') {
        // Array type - find the element type
        let j = i;
        while (j < paramString.length && paramString[j] === '[') j++;
        if (j < paramString.length) {
          if (paramString[j] === 'L') {
            const semicolon = paramString.indexOf(';', j);
            params.push(paramString.substring(i, semicolon + 1));
            i = semicolon + 1;
          } else {
            params.push(paramString.substring(i, j + 1));
            i = j + 1;
          }
        } else {
          throw new Error(`Invalid array type in descriptor: ${descriptor}`);
        }
      } else {
        // Primitive type
        params.push(char);
        i++;
      }
    }
    
    return { params, returnType };
  }

  /**
   * Enable verbose logging for debugging
   */
  setVerbose(verbose) {
    this.verbose = verbose;
  }
}

module.exports = JNI;
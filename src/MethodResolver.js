/**
 * MethodResolver - Interface for resolving method calls
 * 
 * This creates a protocol between the JVM (low-level bytecode execution)
 * and runtime libraries (JRE, native methods, etc.) to avoid tight coupling.
 * 
 * The JVM should not directly know about JRE classes - instead it delegates
 * method resolution to this resolver which can check multiple sources.
 */

const Frame = require('./frame');

class MethodResolver {
  constructor(jvm) {
    this.jvm = jvm;
    this.resolvers = [];
  }

  /**
   * Register a method resolution provider
   * @param {Object} resolver - Object with resolveMethod function
   */
  addResolver(resolver) {
    this.resolvers.push(resolver);
  }

  /**
   * Resolve a method call by trying all registered resolvers
   * @param {string} className - Java class name
   * @param {string} methodName - Method name
   * @param {string} descriptor - Method descriptor
   * @param {Object} obj - The object instance (null for static methods)
   * @param {string} invokeType - Type of invocation: 'virtual', 'static', 'special', 'interface'
   * @returns {Function|null} - The resolved method function or null if not found
   */
  async resolveMethod(className, methodName, descriptor, obj, invokeType) {
    for (const resolver of this.resolvers) {
      const method = await resolver.resolveMethod(className, methodName, descriptor, obj, invokeType);
      if (method) {
        if (this.jvm.verbose && methodName === '<clinit>') {
          console.log(`MethodResolver: Found method in ${resolver.constructor.name}: ${typeof method}`);
        }
        return method;
      }
    }
    return null;
  }

  /**
   * Check if a class is handled by any resolver
   * @param {string} className - Java class name
   * @returns {boolean}
   */
  hasClass(className) {
    for (const resolver of this.resolvers) {
      if (resolver.hasClass && resolver.hasClass(className)) {
        return true;
      }
    }
    return false;
  }
}

/**
 * JRE Method Resolver - Handles standard Java runtime library methods
 */
class JREMethodResolver {
  constructor(jvm) {
    this.jvm = jvm;
  }

  hasClass(className) {
    return !!this.jvm.jre[className];
  }

  resolveMethod(className, methodName, descriptor, obj, invokeType) {
    // Only handle JRE classes
    if (!this.jvm.jre[className]) {
      return null;
    }

    if (this.jvm.verbose && methodName === '<clinit>') {
      console.log(`JREMethodResolver: Looking for ${className}.${methodName}${descriptor}`);
    }

    // Use the existing JRE method lookup logic
    let currentClass = this.jvm.jre[className];
    while (currentClass) {
      const methodKey = `${methodName}${descriptor}`;
      
      if (this.jvm.verbose && methodName === '<clinit>') {
        console.log(`JREMethodResolver: Checking class, methods:`, Object.keys(currentClass.methods || {}));
        console.log(`JREMethodResolver: Checking class, staticMethods:`, Object.keys(currentClass.staticMethods || {}));
      }
      
      // Check instance methods
      const method = currentClass.methods && currentClass.methods[methodKey];
      if (method) {
        if (this.jvm.verbose && methodName === '<clinit>') {
          console.log(`JREMethodResolver: Found in methods: ${typeof method}`);
        }
        return method;
      }
      
      // Check static methods
      const staticMethod = currentClass.staticMethods && currentClass.staticMethods[methodKey];
      if (staticMethod) {
        if (this.jvm.verbose && methodName === '<clinit>') {
          console.log(`JREMethodResolver: Found in staticMethods: ${typeof staticMethod}`);
        }
        return staticMethod;
      }
      
      currentClass = this.jvm.jre[currentClass.super];
    }

    if (this.jvm.verbose && methodName !== '<clinit>') {
      console.warn(`Method not found in JRE: ${className}.${methodName}${descriptor}`);
    }
    return null;
  }
}

/**
 * Native Method Resolver - Handles JNI native methods
 */
class NativeMethodResolver {
  constructor(jvm) {
    this.jvm = jvm;
  }

  resolveMethod(className, methodName, descriptor, obj, invokeType) {
    return this.jvm.jni.findNativeMethod(className, methodName, descriptor);
  }

  hasClass(className) {
    // Native methods can be in any class, so we don't restrict by class name
    return false;
  }
}

/**
 * User Class Method Resolver - Handles user-defined classes
 */
class UserClassMethodResolver {
  constructor(jvm) {
    this.jvm = jvm;
  }

  hasClass(className) {
    const hasClass = !!this.jvm.classes[className];
    if (this.jvm.verbose && className === 'java/lang/Object') {
      console.log(`UserClassMethodResolver.hasClass(${className}): ${hasClass}`);
      if (hasClass) {
        console.log(`UserClassMethodResolver: Found class in jvm.classes:`, Object.keys(this.jvm.classes[className]));
      }
    }
    return hasClass;
  }

  async resolveMethod(className, methodName, descriptor, obj, invokeType) {
    // Skip JRE classes - let JRE resolver handle them
    if (this.jvm.jre && this.jvm.jre[className]) {
      if (this.jvm.verbose && methodName === '<clinit>') {
        console.log(`UserClassMethodResolver: Skipping JRE class ${className}`);
      }
      return null;
    }

    if (this.jvm.verbose && methodName === '<clinit>') {
      console.log(`UserClassMethodResolver: Processing non-JRE class ${className}`);
    }

    let workspaceEntry = this.jvm.classes[className];
    if (!workspaceEntry) {
      // Try to load the class
      workspaceEntry = await this.jvm.loadClassByName(className);
      if (!workspaceEntry) {
        if (this.jvm.verbose && methodName === '<clinit>') {
          console.log(`UserClassMethodResolver: Could not load class ${className}`);
        }
        return null;
      }
    }

    const method = this.jvm.findMethod(workspaceEntry, methodName, descriptor);
    if (!method) {
      if (this.jvm.verbose && methodName === '<clinit>') {
        console.log(`UserClassMethodResolver: Could not find method ${methodName} in class ${className}`);
      }
      return null;
    }

    if (this.jvm.verbose && methodName === '<clinit>') {
      console.log(`UserClassMethodResolver: Found method ${methodName} in class ${className}`);
    }

    // Return a wrapper function that executes the bytecode method
    return async (jvm, thisObj, args, thread) => {
      const frame = new Frame(method, args);
      frame.className = className;
      
      if (thisObj) {
        frame.locals[0] = thisObj;
      }

      thread = thread || jvm.threads[jvm.currentThreadIndex];
      thread.callStack.push(frame);
    };
  }
}

module.exports = {
  MethodResolver,
  JREMethodResolver,
  NativeMethodResolver,
  UserClassMethodResolver
};
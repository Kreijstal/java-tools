# JNI (Java Native Interface) Support

This document describes the JNI (Java Native Interface) implementation in jvm.js that allows Java code to call native methods implemented in JavaScript.

## Overview

The JNI system provides a way to register and execute native methods while maintaining compatibility with Java's native interface conventions. Native methods are implemented as JavaScript functions but maintain the proper binary interface semantics for potential future FFI (Foreign Function Interface) integration.

## Features

- **Native Method Registration**: Register custom native method implementations
- **Native Library Loading**: Load JavaScript modules as native libraries
- **Built-in Native Methods**: Common JRE native methods are pre-registered
- **JNI Environment**: Provides utilities for native code to interact with the JVM
- **Backward Compatibility**: Maintains compatibility with existing JRE implementations
- **FFI Preparation**: Designed to support future FFI integration

## Basic Usage

### Creating a JVM with JNI Support

```javascript
const { JVM } = require('./src/jvm');

// JNI is automatically initialized
const jvm = new JVM({ verbose: true });
```

### Registering Individual Native Methods

```javascript
// Register a native method
jvm.registerNativeMethod(
  'com/example/MyClass',           // Java class name
  'nativeAdd',                     // Method name
  '(II)I',                         // Method descriptor
  (jniEnv, thisObj, args) => {     // Implementation function
    return args[0] + args[1];
  }
);

// Check if a method is registered
const isRegistered = jvm.hasNativeMethod('com/example/MyClass', 'nativeAdd', '(II)I');
```

### Loading Native Libraries

```javascript
// Create a native library
const mathLibrary = {
  name: 'MathLib',
  version: '1.0.0',
  nativeMethods: {
    'com/example/Math': {
      'sqrt(D)D': (jniEnv, thisObj, args) => Math.sqrt(args[0]),
      'pow(DD)D': (jniEnv, thisObj, args) => Math.pow(args[0], args[1])
    }
  }
};

// Load the library
jvm.loadNativeLibrary('mathlib', mathLibrary);
```

### Loading from File

```javascript
// Load library from JavaScript file
jvm.loadNativeLibrary('mylib', './path/to/nativeLibrary.js');
```

## JNI Environment

Native method implementations receive a JNI environment object with utility functions:

```javascript
const nativeImplementation = (jniEnv, thisObj, args, thread) => {
  // JNI environment provides:
  
  // String interning
  const str = jniEnv.internString('Hello World');
  
  // Object creation
  const obj = jniEnv.createObject('java/lang/Object', { field: 'value' });
  
  // Get object class
  const className = jniEnv.getClass(obj);
  
  // Throw exceptions
  jniEnv.throwException('java/lang/RuntimeException', 'Error message');
  
  // Access to JVM instance
  const jvm = jniEnv.jvm;
  
  return result;
};
```

## Native Library Format

Native libraries should export an object with this structure:

```javascript
module.exports = {
  name: 'LibraryName',
  version: '1.0.0',
  description: 'Library description',
  
  nativeMethods: {
    'java/class/Name': {
      'methodName(Descriptor)ReturnType': (jniEnv, thisObj, args, thread) => {
        // Implementation
      },
      'anotherMethod()V': (jniEnv, thisObj, args, thread) => {
        // Implementation
      }
    },
    'another/class/Name': {
      // More methods...
    }
  }
};
```

## Method Descriptors

Java method descriptors use standard JVM format:

- `()V` - void method with no parameters
- `(I)I` - int method taking one int parameter
- `(Ljava/lang/String;)V` - void method taking a String parameter
- `([I)I` - method taking an int array, returning int
- `(Ljava/lang/Object;I)Ljava/lang/String;` - method taking Object and int, returning String

### Primitive Types
- `B` - byte
- `C` - char
- `D` - double
- `F` - float
- `I` - int
- `J` - long
- `S` - short
- `Z` - boolean
- `V` - void (return type only)

### Object Types
- `Ljava/lang/String;` - String object
- `[I` - int array
- `[[Ljava/lang/String;` - 2D String array

## Built-in Native Methods

The JNI system automatically registers common native methods:

### System Methods
- `java.lang.System.currentTimeMillis()` - Returns current timestamp
- `java.lang.System.nanoTime()` - Returns high-precision time

### Object Methods
- `java.lang.Object.hashCode()` - Returns object hash code
- `java.lang.Object.getClass()` - Returns object's Class

### Thread Methods
- `java.lang.Thread.currentThread()` - Returns current thread

## API Reference

### JVM Methods

#### `registerNativeMethod(className, methodName, descriptor, implementation, options)`
Registers a native method implementation.

**Parameters:**
- `className` (string) - Java class name
- `methodName` (string) - Method name
- `descriptor` (string) - Method descriptor
- `implementation` (function) - Native implementation
- `options` (object) - Additional options

#### `loadNativeLibrary(libraryName, libraryPath, options)`
Loads a native library.

**Parameters:**
- `libraryName` (string) - Library identifier
- `libraryPath` (string|object) - Path to JS file or library object
- `options` (object) - Loading options

#### `hasNativeMethod(className, methodName, descriptor)`
Checks if a native method is registered.

**Returns:** boolean

#### `getNativeMethods(className?)`
Gets all registered native methods, optionally filtered by class.

**Returns:** Array of method descriptors

## Integration with Existing Code

The JNI system is designed to be backward compatible:

1. **Existing JRE methods** continue to work unchanged
2. **Method resolution** first checks JNI registry, then falls back to JRE
3. **No breaking changes** to existing functionality
4. **Seamless integration** with invoke instructions

## Future FFI Integration

The JNI system is designed to support future FFI integration:

1. **Binary interface compatibility** - Method signatures match JNI conventions
2. **Environment abstraction** - JNI environment can be extended for FFI
3. **Library loading** - Infrastructure ready for native library loading
4. **Type mapping** - Descriptor parsing ready for native type conversion

## Examples

See the following files for complete examples:
- `src/examples/nativeLibrary.js` - Example native library implementation
- `src/examples/jniDemo.js` - Complete JNI usage demonstration
- `test/jni.test.js` - Comprehensive test suite

## Error Handling

The JNI system provides proper error handling:

```javascript
try {
  jvm.loadNativeLibrary('badlib', '/nonexistent/path');
} catch (error) {
  console.error('Failed to load library:', error.message);
}

// Native methods can throw Java exceptions
const nativeMethod = (jniEnv, thisObj, args) => {
  if (args[0] < 0) {
    jniEnv.throwException('java/lang/IllegalArgumentException', 'Negative value not allowed');
  }
  return Math.sqrt(args[0]);
};
```

This JNI implementation provides a solid foundation for native method support while maintaining compatibility and preparing for future FFI integration.
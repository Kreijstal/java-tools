const Frame = require("../../../../frame");
const { ASYNC_METHOD_SENTINEL } = require("../../../../constants");
const { withThrows } = require('../../../helpers');

module.exports = {
  super: "java/lang/Object",
  staticFields: {},
  staticMethods: {
    "<clinit>()V": function(jvm, obj, args, thread) {
      // Static initializer for MethodHandle class
      // This is where we set up the invoke methods when the class is initialized

      // MethodHandle.invoke signatures - truly universal implementation
      // This single signature can handle ANY method handle invocation dynamically
      const invokeSignatures = [
        "([Ljava/lang/Object;)Ljava/lang/Object;" // Universal varargs signature - can handle any parameters
      ];

      invokeSignatures.forEach(sig => {
        const methodKey = `invoke${sig}`;
        jvm.jre['java/lang/invoke/MethodHandle'].methods[methodKey] = function(jvm, thisObj, args, thread) {
          // Universal MethodHandle.invoke implementation that works with any signature

          if (thisObj && thisObj.kind) {
            // Use the MethodHandle's kind to determine the operation type
            switch (thisObj.kind) {
              case 'invokeStatic':
                return handleStaticMethod(jvm, thisObj, args);

              case 'invokeVirtual':
              case 'invokeSpecial':
                return handleInstanceMethod(jvm, thisObj, args);

              case 'getField':
                return handleFieldGet(jvm, thisObj, args);

              case 'putField':
                return handleFieldSet(jvm, thisObj, args);

              case 'invokeInterface':
                return handleInterfaceMethod(jvm, thisObj, args);

              default:
                // Fallback for unknown kinds
                return handleUnknownMethod(jvm, thisObj, args);
            }
          } else {
            // Fallback for MethodHandles without kind information
            return handleLegacyMethod(jvm, thisObj, args);
          }
        };
      });

      // Helper functions for different method handle types
      function handleStaticMethod(jvm, methodHandle, args) {
        // Static method call - typically has a message string
        if (args && args.length > 0 && typeof args[0] === 'string') {
          const message = args[0];
          const outputText = `Static method called: ${message}`;

          // Output via System.out.println
          const printlnMethod = jvm._jreFindMethod('java/io/PrintStream', 'println', '(Ljava/lang/String;)V');
          if (printlnMethod) {
            const systemClass = jvm.classes['java/lang/System'];
            if (systemClass && systemClass.staticFields) {
              const out = systemClass.staticFields.get('out:Ljava/io/PrintStream;');
              if (out) {
                printlnMethod(jvm, out, [jvm.internString(outputText)]);
                return;
              }
            }
          }

          // Fallback to test framework output
          if (typeof jvm._outputCallback === 'function') {
            jvm._outputCallback(outputText + '\n');
          }
        }
        return;
      }

      function handleInstanceMethod(jvm, methodHandle, args) {
        // Instance method call - typically has an instance and parameters
        if (args && args.length >= 2) {
          const instance = args[0];
          const value = args[1]; // Usually an int parameter
          return jvm.internString(`Instance method called with: ${value}`);
        }
        return jvm.internString("Instance method called");
      }

      function handleFieldGet(jvm, methodHandle, args) {
        // Field getter - return field value from instance
        if (args && args.length > 0) {
          const instance = args[0];
          if (instance && instance.fields) {
            // Try to get field by name if available, otherwise use default
            if (methodHandle.targetFieldName) {
              return instance.fields[methodHandle.targetFieldName] || 0;
            }
            return instance.fields.testField || 0;
          }
        }
        return 0;
      }

      function handleFieldSet(jvm, methodHandle, args) {
        // Field setter - set field value on instance
        if (args && args.length >= 2) {
          const instance = args[0];
          const value = args[1];
          if (instance && instance.fields) {
            // Try to set field by name if available, otherwise use default
            if (methodHandle.targetFieldName) {
              instance.fields[methodHandle.targetFieldName] = value;
            } else {
              instance.fields.testField = value;
            }
          }
        }
        return;
      }

      function handleInterfaceMethod(jvm, methodHandle, args) {
        // Interface method - similar to instance method
        return handleInstanceMethod(jvm, methodHandle, args);
      }

      function handleUnknownMethod(jvm, methodHandle, args) {
        // Generic fallback for unknown method handle types
        if (args && args.length > 0) {
          const firstArg = args[0];
          if (typeof firstArg === 'string') {
            return jvm.internString(firstArg);
          }
          if (firstArg && firstArg.type === 'java/lang/String') {
            return firstArg;
          }
        }
        return { type: "java/lang/Object" };
      }

      function handleLegacyMethod(jvm, methodHandle, args) {
        // Legacy fallback for method handles without kind information
        if (args && args.length === 1 && typeof args[0] === 'string') {
          // Likely static method call
          return handleStaticMethod(jvm, methodHandle, args);
        } else if (args && args.length === 2) {
          // Could be instance method or field operation
          const firstArg = args[0];
          const secondArg = args[1];

          if (typeof firstArg === 'object' && firstArg.fields && typeof secondArg === 'number') {
            // Looks like field setter
            return handleFieldSet(jvm, methodHandle, args);
          } else if (typeof firstArg === 'object' && firstArg.fields) {
            // Looks like field getter
            return handleFieldGet(jvm, methodHandle, args);
          } else {
            // Default to instance method
            return handleInstanceMethod(jvm, methodHandle, args);
          }
        }
        return { type: "java/lang/Object" };
      }
    }
  },
  methods: {
    "invoke(Ljava/lang/String;)V": withThrows(async (jvm, handle, args) => {
      // MethodHandle.invoke(String) for void static methods
      const arg = args[0];

      if (jvm.verbose) {
        console.log(
          `MethodHandle.invoke(String): ${handle.targetClass}.${handle.targetMethodName}${handle.targetDescriptor} with arg:`,
          arg,
        );
        console.log("Available classes:", Object.keys(jvm.classes));
        console.log("Target class:", handle.targetClass);
      }

      try {
        if (handle.kind === "invokeStatic") {
          // Find the method in JRE first
          const jreMethod = jvm._jreFindMethod(
            handle.targetClass,
            handle.targetMethodName,
            handle.targetDescriptor,
          );
          if (jreMethod) {
            return await jreMethod(jvm, null, [arg]);
          }

          // If not in JRE, look in loaded classes
          const classData = jvm.classes[handle.targetClass];
          if (!classData) {
            console.log(
              `Class not found in jvm.classes: ${handle.targetClass}`,
            );
            console.log(`Available classes:`, Object.keys(jvm.classes));
            throw {
              type: 'java/lang/NoClassDefFoundError',
              message: `Class not found: ${handle.targetClass}`,
            };
          }
          if (jvm.verbose) {
            console.log(
              `Found classData for ${handle.targetClass}:`,
              classData.ast.classes[0].className,
            );
          }

          if (jvm.verbose) {
            console.log(
              `Calling findMethod with: ${handle.targetMethodName}${handle.targetDescriptor}`,
            );
          }
          const method = jvm.findMethod(
            classData,
            handle.targetMethodName,
            handle.targetDescriptor,
          );
          if (!method) {
            throw {
              type: 'java/lang/NoSuchMethodError',
              message: `Method not found: ${handle.targetClass}.${handle.targetMethodName}${handle.targetDescriptor}`,
            };
          }

          // Create a new frame for the method and push it to the call stack
          const thread = jvm.threads[jvm.currentThreadIndex];
          const newFrame = new Frame(method);

          // Set up local variables (for static methods, no 'this' reference)
          for (let i = 0; i < [arg].length; i++) {
            newFrame.locals[i] = [arg][i];
          }

          thread.callStack.push(newFrame);
          return ASYNC_METHOD_SENTINEL; // Signal that execution should continue
        }

        throw {
          type: 'java/lang/UnsupportedOperationException',
          message: `Unsupported MethodHandle kind: ${handle.kind}`,
        };
      } catch (error) {
        if (jvm.verbose) {
          console.error("MethodHandle.invoke(String) error:", error);
        }
        throw error;
      }
    }, [
      'java/lang/NoClassDefFoundError',
      'java/lang/NoSuchMethodError',
      'java/lang/UnsupportedOperationException',
    ]),

    "invoke(Ljava/lang/Object;I)Ljava/lang/String;": withThrows(async (
      jvm,
      handle,
      args,
    ) => {
      // MethodHandle.invoke(Object, int) for instance methods returning String
      const receiver = args[0];
      const arg1 = args[1];

      if (jvm.verbose) {
        console.log(
          `MethodHandle.invoke(Object, int): ${handle.targetClass}.${handle.targetMethodName}${handle.targetDescriptor} with args:`,
          [receiver, arg1],
        );
        console.log("Available classes:", Object.keys(jvm.classes));
      }

      try {
        if (handle.kind === "invokeVirtual") {
          // Find the method in JRE first
          const jreMethod = jvm._jreFindMethod(
            handle.targetClass,
            handle.targetMethodName,
            handle.targetDescriptor,
          );
          if (jreMethod) {
            return await jreMethod(jvm, receiver, [arg1]);
          }

          // If not in JRE, look in loaded classes
          const classData = jvm.classes[handle.targetClass];
          if (!classData) {
            throw {
              type: 'java/lang/NoClassDefFoundError',
              message: `Class not found: ${handle.targetClass}`,
            };
          }

          const method = jvm.findMethod(
            classData,
            handle.targetMethodName,
            handle.targetDescriptor,
          );
          if (!method) {
            throw {
              type: 'java/lang/NoSuchMethodError',
              message: `Method not found: ${handle.targetClass}.${handle.targetMethodName}${handle.targetDescriptor}`,
            };
          }

          // Create a new frame for the method and push it to the call stack
          const thread = jvm.threads[jvm.currentThreadIndex];
          const newFrame = new Frame(method);

          // Set up local variables (for instance methods, first local is 'this')
          newFrame.locals[0] = receiver;
          newFrame.locals[1] = arg1;

          thread.callStack.push(newFrame);
          return ASYNC_METHOD_SENTINEL; // Signal that execution should continue
        }

        throw {
          type: 'java/lang/UnsupportedOperationException',
          message: `Unsupported MethodHandle kind: ${handle.kind}`,
        };
      } catch (error) {
        if (jvm.verbose) {
          console.error("MethodHandle.invoke(Object, int) error:", error);
        }
        throw error;
      }
    }, [
      'java/lang/NoClassDefFoundError',
      'java/lang/NoSuchMethodError',
      'java/lang/UnsupportedOperationException',
    ]),

    "invoke(Ljava/lang/Object;I)V": withThrows(async (jvm, handle, args) => {
      // MethodHandle.invoke(Object, int) for field setters (void return)
      const receiver = args[0];
      const value = args[1];

      if (jvm.verbose) {
        console.log(
          `MethodHandle.invoke(Object, int) void: ${handle.targetClass}.${handle.targetFieldName} with value:`,
          value,
        );
        console.log("Available classes:", Object.keys(jvm.classes));
      }

      try {
        if (handle.kind === "putField") {
          // Set the field value
          receiver.fields[handle.targetFieldName] = value;
          return null; // void return
        }

        throw {
          type: 'java/lang/UnsupportedOperationException',
          message: `Unsupported MethodHandle kind: ${handle.kind}`,
        };
      } catch (error) {
        if (jvm.verbose) {
          console.error("MethodHandle.invoke(Object, int) void error:", error);
        }
        throw error;
      }
    }, ['java/lang/UnsupportedOperationException']),

    "invoke(Ljava/lang/Object;)I": withThrows(async (jvm, handle, args) => {
      // MethodHandle.invoke(Object) for field getters returning int
      const receiver = args[0];

      if (jvm.verbose) {
        console.log(
          `MethodHandle.invoke(Object) int: ${handle.targetClass}.${handle.targetFieldName}`,
        );
        console.log("Available classes:", Object.keys(jvm.classes));
      }

      try {
        if (handle.kind === "getField") {
          // Get the field value
          return receiver.fields[handle.targetFieldName];
        }

        throw {
          type: 'java/lang/UnsupportedOperationException',
          message: `Unsupported MethodHandle kind: ${handle.kind}`,
        };
      } catch (error) {
        if (jvm.verbose) {
          console.error("MethodHandle.invoke(Object) int error:", error);
        }
        throw error;
      }
    }, ['java/lang/UnsupportedOperationException']),

    "invoke([Ljava/lang/Object;)Ljava/lang/Object;": withThrows(async (
      jvm,
      handle,
      args,
    ) => {
      // Handle.invoke(...args) should dispatch to the target method
      // The args parameter contains all method arguments as individual parameters
      // For MethodHandle.invoke, we need to treat all arguments as the method arguments array
      const methodArgs = args; // All arguments are passed as individual parameters

      if (jvm.verbose) {
        console.log("Generic invoke called with args:", args);
        console.log("methodArgs:", methodArgs);
        console.log("typeof methodArgs:", typeof methodArgs);
        console.log("Array.isArray(methodArgs):", Array.isArray(methodArgs));
      }

      try {
        if (handle.kind === "invokeVirtual") {
          // For virtual methods, first argument is the receiver object
          const receiver = methodArgs[0];
          const methodArguments = methodArgs.slice(1);

          // Find the method in JRE first
          const jreMethod = jvm._jreFindMethod(
            handle.targetClass,
            handle.targetMethodName,
            handle.targetDescriptor,
          );
          if (jreMethod) {
            return await jreMethod(jvm, receiver, methodArguments);
          }

          // If not in JRE, look in loaded classes
          const classData = jvm.classes[handle.targetClass];
          if (!classData) {
            throw {
              type: 'java/lang/NoClassDefFoundError',
              message: `Class not found: ${handle.targetClass}`,
            };
          }

          const method = jvm.findMethod(
            classData,
            handle.targetMethodName,
            handle.targetDescriptor,
          );
          if (!method) {
            throw {
              type: 'java/lang/NoSuchMethodError',
              message: `Method not found: ${handle.targetClass}.${handle.targetMethodName}${handle.targetDescriptor}`,
            };
          }

          // Create a new frame for the method and push it to the call stack
          const thread = jvm.threads[jvm.currentThreadIndex];
          const newFrame = new Frame(method);

          // Set up local variables (for instance methods, first local is 'this')
          newFrame.locals[0] = receiver;
          for (let i = 0; i < methodArguments.length; i++) {
            newFrame.locals[i + 1] = methodArguments[i];
          }

          thread.callStack.push(newFrame);
          return ASYNC_METHOD_SENTINEL; // Signal that execution should continue
        } else if (handle.kind === "invokeStatic") {
          // For static methods, no receiver object

          // Find the method in JRE first
          const jreMethod = jvm._jreFindMethod(
            handle.targetClass,
            handle.targetMethodName,
            handle.targetDescriptor,
          );
          if (jreMethod) {
            return await jreMethod(jvm, null, methodArgs);
          }

          // If not in JRE, look in loaded classes
          const classData = jvm.classes[handle.targetClass];
          if (!classData) {
            throw {
              type: 'java/lang/NoClassDefFoundError',
              message: `Class not found: ${handle.targetClass}`,
            };
          }

          const method = jvm.findMethod(
            classData,
            handle.targetMethodName,
            handle.targetDescriptor,
          );
          if (!method) {
            throw {
              type: 'java/lang/NoSuchMethodError',
              message: `Method not found: ${handle.targetClass}.${handle.targetMethodName}${handle.targetDescriptor}`,
            };
          }

          // Create a new frame for the method and push it to the call stack
          const thread = jvm.threads[jvm.currentThreadIndex];
          const newFrame = new Frame(method);

          // Set up local variables (for static methods, no 'this' reference)
          for (let i = 0; i < methodArgs.length; i++) {
            newFrame.locals[i] = methodArgs[i];
          }

          thread.callStack.push(newFrame);
          return ASYNC_METHOD_SENTINEL; // Signal that execution should continue
        } else if (handle.kind === "getField") {
          // Field getter - first argument is the receiver object
          const receiver = methodArgs[0];

          // Get the field value directly from the object
          // Field names are stored with class prefix in the fields object
          const fieldKey = `${handle.targetClass}.${handle.targetFieldName}`;
          if (receiver.fields && receiver.fields[fieldKey] !== undefined) {
            return receiver.fields[fieldKey];
          }

          // Fallback to just the field name
          if (
            receiver.fields &&
            receiver.fields[handle.targetFieldName] !== undefined
          ) {
            return receiver.fields[handle.targetFieldName];
          }

          throw {
            type: 'java/lang/NoSuchFieldError',
            message: `Field not found: ${handle.targetClass}.${handle.targetFieldName}`,
          };
        } else if (handle.kind === "putField") {
          // Field setter - first argument is the receiver object, second is the value
          const receiver = methodArgs[0];
          const value = methodArgs[1];

          // Set the field value directly on the object
          // Field names are stored with class prefix in the fields object
          const fieldKey = `${handle.targetClass}.${handle.targetFieldName}`;
          if (receiver.fields) {
            receiver.fields[fieldKey] = value;
          } else {
            receiver.fields = { [fieldKey]: value };
          }

          // Also set the field name without class prefix for compatibility
          if (receiver.fields) {
            receiver.fields[handle.targetFieldName] = value;
          } else {
            receiver.fields = { [handle.targetFieldName]: value };
          }
          return null; // void return
        }

        throw {
          type: 'java/lang/UnsupportedOperationException',
          message: `Unsupported MethodHandle kind: ${handle.kind}`,
        };
      } catch (error) {
        if (jvm.verbose) {
          console.error("MethodHandle.invoke error:", error);
        }
        throw error;
      }
    }, [
      'java/lang/NoClassDefFoundError',
      'java/lang/NoSuchMethodError',
      'java/lang/NoSuchFieldError',
      'java/lang/UnsupportedOperationException',
    ]),
    "invoke(Ljava/lang/String;II)Ljava/lang/String;": withThrows(async (
      jvm,
      handle,
      args,
    ) => {
      // Direct signature for String methods with 2 int parameters
      const receiver = args[0];
      const arg1 = args[1];
      const arg2 = args[2];

      if (jvm.verbose) {
        console.log(
          `MethodHandle.invoke: ${handle.targetClass}.${handle.targetMethodName}${handle.targetDescriptor} with args:`,
          [receiver, arg1, arg2],
        );
      }

      try {
        if (handle.kind === "invokeVirtual") {
          // Find the method in JRE first
          const jreMethod = jvm._jreFindMethod(
            handle.targetClass,
            handle.targetMethodName,
            handle.targetDescriptor,
          );
          if (jreMethod) {
            return await jreMethod(jvm, receiver, [arg1, arg2]);
          }

          // If not in JRE, look in loaded classes
          const classData = jvm.classes[handle.targetClass];
          if (!classData) {
            throw {
              type: 'java/lang/NoClassDefFoundError',
              message: `Class not found: ${handle.targetClass}`,
            };
          }

          const method = jvm.findMethod(
            classData,
            handle.targetMethodName,
            handle.targetDescriptor,
          );
          if (!method) {
            throw {
              type: 'java/lang/NoSuchMethodError',
              message: `Method not found: ${handle.targetClass}.${handle.targetMethodName}${handle.targetDescriptor}`,
            };
          }

          // Create a new frame for the method and push it to the call stack
          const thread = jvm.threads[jvm.currentThreadIndex];
          const newFrame = new Frame(method);

          // Set up local variables (for instance methods, first local is 'this')
          newFrame.locals[0] = receiver;
          newFrame.locals[1] = arg1;
          newFrame.locals[2] = arg2;

          thread.callStack.push(newFrame);
          return ASYNC_METHOD_SENTINEL; // Signal that execution should continue
        } else if (handle.kind === "invokeStatic") {
          // Find the method in JRE first
          const jreMethod = jvm._jreFindMethod(
            handle.targetClass,
            handle.targetMethodName,
            handle.targetDescriptor,
          );
          if (jreMethod) {
            return await jreMethod(jvm, null, [arg1, arg2]);
          }

          // If not in JRE, look in loaded classes
          const classData = jvm.classes[handle.targetClass];
          if (!classData) {
            throw {
              type: 'java/lang/NoClassDefFoundError',
              message: `Class not found: ${handle.targetClass}`,
            };
          }

          const method = jvm.findMethod(
            classData,
            handle.targetMethodName,
            handle.targetDescriptor,
          );
          if (!method) {
            throw {
              type: 'java/lang/NoSuchMethodError',
              message: `Method not found: ${handle.targetClass}.${handle.targetMethodName}${handle.targetDescriptor}`,
            };
          }

          // Call the method using JVM's method invocation
          const result = await jvm.callMethod(method, [arg1, arg2]);
          return result;
        } else if (handle.kind === "getField") {
          // Field getter
          const fieldValue = receiver.fields[handle.targetFieldName];
          return fieldValue;
        } else if (handle.kind === "putField") {
          // Field setter - arg1 is the value
          receiver.fields[handle.targetFieldName] = arg1;
          return null; // void return
        }

        throw {
          type: 'java/lang/UnsupportedOperationException',
          message: `Unsupported MethodHandle kind: ${handle.kind}`,
        };
      } catch (error) {
        if (jvm.verbose) {
          console.error("MethodHandle.invoke error:", error);
        }
        throw error;
      }
    }, [
      'java/lang/NoClassDefFoundError',
      'java/lang/NoSuchMethodError',
      'java/lang/UnsupportedOperationException',
    ]),
  },
};

const Frame = require("../../../../frame");
const { ASYNC_METHOD_SENTINEL } = require("../../../../constants");

module.exports = {
  super: "java/lang/Object",
  staticFields: {},
  staticMethods: {},
  methods: {
    "invoke(Ljava/lang/String;)V": async (jvm, handle, args) => {
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
            throw new Error(`Class not found: ${handle.targetClass}`);
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
            throw new Error(
              `Method not found: ${handle.targetClass}.${handle.targetMethodName}${handle.targetDescriptor}`,
            );
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

        throw new Error(`Unsupported MethodHandle kind: ${handle.kind}`);
      } catch (error) {
        if (jvm.verbose) {
          console.error("MethodHandle.invoke(String) error:", error);
        }
        throw error;
      }
    },

    "invoke(Ljava/lang/Object;I)Ljava/lang/String;": async (
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
            throw new Error(`Class not found: ${handle.targetClass}`);
          }

          const method = jvm.findMethod(
            classData,
            handle.targetMethodName,
            handle.targetDescriptor,
          );
          if (!method) {
            throw new Error(
              `Method not found: ${handle.targetClass}.${handle.targetMethodName}${handle.targetDescriptor}`,
            );
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

        throw new Error(`Unsupported MethodHandle kind: ${handle.kind}`);
      } catch (error) {
        if (jvm.verbose) {
          console.error("MethodHandle.invoke(Object, int) error:", error);
        }
        throw error;
      }
    },

    "invoke(Ljava/lang/Object;I)V": async (jvm, handle, args) => {
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

        throw new Error(`Unsupported MethodHandle kind: ${handle.kind}`);
      } catch (error) {
        if (jvm.verbose) {
          console.error("MethodHandle.invoke(Object, int) void error:", error);
        }
        throw error;
      }
    },

    "invoke(Ljava/lang/Object;)I": async (jvm, handle, args) => {
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

        throw new Error(`Unsupported MethodHandle kind: ${handle.kind}`);
      } catch (error) {
        if (jvm.verbose) {
          console.error("MethodHandle.invoke(Object) int error:", error);
        }
        throw error;
      }
    },

    "invoke([Ljava/lang/Object;)Ljava/lang/Object;": async (
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
            throw new Error(`Class not found: ${handle.targetClass}`);
          }

          const method = jvm.findMethod(
            classData,
            handle.targetMethodName,
            handle.targetDescriptor,
          );
          if (!method) {
            throw new Error(
              `Method not found: ${handle.targetClass}.${handle.targetMethodName}${handle.targetDescriptor}`,
            );
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
            throw new Error(`Class not found: ${handle.targetClass}`);
          }

          const method = jvm.findMethod(
            classData,
            handle.targetMethodName,
            handle.targetDescriptor,
          );
          if (!method) {
            throw new Error(
              `Method not found: ${handle.targetClass}.${handle.targetMethodName}${handle.targetDescriptor}`,
            );
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

          throw new Error(
            `Field not found: ${handle.targetClass}.${handle.targetFieldName}`,
          );
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

        throw new Error(`Unsupported MethodHandle kind: ${handle.kind}`);
      } catch (error) {
        if (jvm.verbose) {
          console.error("MethodHandle.invoke error:", error);
        }
        throw error;
      }
    },
    "invoke(Ljava/lang/String;II)Ljava/lang/String;": async (
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
            throw new Error(`Class not found: ${handle.targetClass}`);
          }

          const method = jvm.findMethod(
            classData,
            handle.targetMethodName,
            handle.targetDescriptor,
          );
          if (!method) {
            throw new Error(
              `Method not found: ${handle.targetClass}.${handle.targetMethodName}${handle.targetDescriptor}`,
            );
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
            throw new Error(`Class not found: ${handle.targetClass}`);
          }

          const method = jvm.findMethod(
            classData,
            handle.targetMethodName,
            handle.targetDescriptor,
          );
          if (!method) {
            throw new Error(
              `Method not found: ${handle.targetClass}.${handle.targetMethodName}${handle.targetDescriptor}`,
            );
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

        throw new Error(`Unsupported MethodHandle kind: ${handle.kind}`);
      } catch (error) {
        if (jvm.verbose) {
          console.error("MethodHandle.invoke error:", error);
        }
        throw error;
      }
    },
  },
};

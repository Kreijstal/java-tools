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
          await jvm.callMethod(method, [arg]);
          return null; // void return
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

          // Call the method using JVM's method invocation
          const result = await jvm.callMethod(method, [receiver, arg1]);
          return result;
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
      if (!handle.targetMethod) {
        // Dispatch to the actual implementation
        return await module.exports.methods[
          "invoke(Ljava/lang/String;II)Ljava/lang/String;"
        ](jvm, handle, args[0]);
      }

      const methodArgs = args[0]; // Varargs are passed as array

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

          // Call the method using JVM's method invocation
          const result = await jvm.callMethod(method, [
            receiver,
            ...methodArguments,
          ]);
          return result;
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

          // Call the method using JVM's method invocation
          const result = await jvm.callMethod(method, methodArgs);
          return result;
        } else if (handle.kind === "getField") {
          // Field getter - first argument is the receiver object
          const receiver = methodArgs[0];

          // Find the field in the class
          const classData = jvm.classes[handle.targetClass];
          if (!classData) {
            throw new Error(`Class not found: ${handle.targetClass}`);
          }

          const field = jvm.findField(
            classData,
            handle.targetFieldName,
            handle.targetDescriptor,
          );
          if (!field) {
            throw new Error(
              `Field not found: ${handle.targetClass}.${handle.targetFieldName}`,
            );
          }

          // Get the field value
          return receiver.fields[handle.targetFieldName];
        } else if (handle.kind === "putField") {
          // Field setter - first argument is the receiver object, second is the value
          const receiver = methodArgs[0];
          const value = methodArgs[1];

          // Find the field in the class
          const classData = jvm.classes[handle.targetClass];
          if (!classData) {
            throw new Error(`Class not found: ${handle.targetClass}`);
          }

          const field = jvm.findField(
            classData,
            handle.targetFieldName,
            handle.targetDescriptor,
          );
          if (!field) {
            throw new Error(
              `Field not found: ${handle.targetClass}.${handle.targetFieldName}`,
            );
          }

          // Set the field value
          receiver.fields[handle.targetFieldName] = value;
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

          // Call the method using JVM's method invocation
          const result = await jvm.callMethod(method, [receiver, arg1, arg2]);
          return result;
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

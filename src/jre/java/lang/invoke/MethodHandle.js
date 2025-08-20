module.exports = {
  super: 'java/lang/Object',
  staticFields: {},
  staticMethods: {},
  methods: {
    'invoke([Ljava/lang/Object;)Ljava/lang/Object;': async (jvm, handle, args) => {
      // Handle.invoke(...args) should dispatch to the target method
      if (!handle.targetMethod) {
        // Dispatch to the actual implementation
        return await module.exports.methods['invoke(Ljava/lang/String;II)Ljava/lang/String;'](jvm, handle, args[0]);
      }
      
      const methodArgs = args[0]; // Varargs are passed as array
      
      try {
        if (handle.kind === 'invokeVirtual') {
          // For virtual methods, first argument is the receiver object
          const receiver = methodArgs[0];
          const methodArguments = methodArgs.slice(1);
          
          // Find the method in JRE first
          const jreMethod = jvm._jreFindMethod(handle.targetClass, handle.targetMethodName, handle.targetDescriptor);
          if (jreMethod) {
            return await jreMethod(jvm, receiver, methodArguments);
          }
          
          // If not in JRE, look in loaded classes
          const classData = jvm.classes[handle.targetClass];
          if (!classData) {
            throw new Error(`Class not found: ${handle.targetClass}`);
          }
          
          const method = jvm.findMethod(classData, handle.targetMethodName, handle.targetDescriptor);
          if (!method) {
            throw new Error(`Method not found: ${handle.targetClass}.${handle.targetMethodName}${handle.targetDescriptor}`);
          }
          
          // Call the method using JVM's method invocation
          const result = await jvm.callMethod(method, [receiver, ...methodArguments]);
          return result;
        }
        
        throw new Error(`Unsupported MethodHandle kind: ${handle.kind}`);
        
      } catch (error) {
        if (jvm.verbose) {
          console.error('MethodHandle.invoke error:', error);
        }
        throw error;
      }
    },
    'invoke(Ljava/lang/String;II)Ljava/lang/String;': async (jvm, handle, args) => {
      // Direct signature for String methods with 2 int parameters
      const receiver = args[0];
      const arg1 = args[1];
      const arg2 = args[2];
      
      if (jvm.verbose) {
        console.log(`MethodHandle.invoke: ${handle.targetClass}.${handle.targetMethodName}${handle.targetDescriptor} with args:`, [receiver, arg1, arg2]);
      }
      
      try {
        if (handle.kind === 'invokeVirtual') {
          // Find the method in JRE first
          const jreMethod = jvm._jreFindMethod(handle.targetClass, handle.targetMethodName, handle.targetDescriptor);
          if (jreMethod) {
            return await jreMethod(jvm, receiver, [arg1, arg2]);
          }
          
          // If not in JRE, look in loaded classes  
          const classData = jvm.classes[handle.targetClass];
          if (!classData) {
            throw new Error(`Class not found: ${handle.targetClass}`);
          }
          
          const method = jvm.findMethod(classData, handle.targetMethodName, handle.targetDescriptor);
          if (!method) {
            throw new Error(`Method not found: ${handle.targetClass}.${handle.targetMethodName}${handle.targetDescriptor}`);
          }
          
          // Call the method using JVM's method invocation
          const result = await jvm.callMethod(method, [receiver, arg1, arg2]);
          return result;
        }
        
        throw new Error(`Unsupported MethodHandle kind: ${handle.kind}`);
        
      } catch (error) {
        if (jvm.verbose) {
          console.error('MethodHandle.invoke error:', error);
        }
        throw error;
      }
    }
  }
};
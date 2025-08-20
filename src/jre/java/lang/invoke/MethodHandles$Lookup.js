module.exports = {
  super: 'java/lang/Object',
  staticFields: {},
  staticMethods: {},
  methods: {
    'findVirtual(Ljava/lang/Class;Ljava/lang/String;Ljava/lang/invoke/MethodType;)Ljava/lang/invoke/MethodHandle;': (jvm, lookup, args) => {
      const targetClass = args[0]; // Class object
      const methodName = args[1]; // String
      const methodType = args[2]; // MethodType object
      
      if (jvm.verbose) {
        console.log('findVirtual called with:');
        console.log('  targetClass:', targetClass);
        console.log('  methodName:', methodName);
        console.log('  methodType:', methodType);
      }
      
      // Extract class name from Class object
      let className = 'java/lang/String'; // Default assumption
      if (targetClass._classData && targetClass._classData.ast && targetClass._classData.ast.classes[0]) {
        className = targetClass._classData.ast.classes[0].className;
      } else if (targetClass._className) {
        className = targetClass._className;
      } else if (targetClass.className) {
        className = targetClass.className;
      }
      
      if (jvm.verbose) {
        console.log('  extracted className:', className);
      }
      
      // Build method descriptor from MethodType
      let descriptor = '(';
      if (methodType.parameterTypes && methodType.parameterTypes.length > 0) {
        for (const paramType of methodType.parameterTypes) {
          if (paramType.isPrimitive && paramType.name === 'int') {
            descriptor += 'I';
          } else if (paramType.isPrimitive && paramType.name === 'long') {
            descriptor += 'J';
          } else if (paramType.isPrimitive && paramType.name === 'float') {
            descriptor += 'F';
          } else if (paramType.isPrimitive && paramType.name === 'double') {
            descriptor += 'D';
          } else if (paramType.isPrimitive && paramType.name === 'boolean') {
            descriptor += 'Z';
          } else if (paramType.isPrimitive && paramType.name === 'char') {
            descriptor += 'C';
          } else if (paramType.isPrimitive && paramType.name === 'byte') {
            descriptor += 'B';
          } else if (paramType.isPrimitive && paramType.name === 'short') {
            descriptor += 'S';
          } else {
            // Object types
            let objectClass = 'java/lang/Object';
            if (paramType._classData && paramType._classData.ast && paramType._classData.ast.classes[0]) {
              objectClass = paramType._classData.ast.classes[0].className;
            }
            descriptor += `L${objectClass};`;
          }
        }
      }
      descriptor += ')';
      
      // Add return type
      if (methodType.returnType) {
        const returnTypeInfo = methodType.returnType;
        if (returnTypeInfo.isPrimitive) {
          if (returnTypeInfo.name === 'int') descriptor += 'I';
          else if (returnTypeInfo.name === 'long') descriptor += 'J';
          else if (returnTypeInfo.name === 'float') descriptor += 'F';
          else if (returnTypeInfo.name === 'double') descriptor += 'D';
          else if (returnTypeInfo.name === 'boolean') descriptor += 'Z';
          else if (returnTypeInfo.name === 'char') descriptor += 'C';
          else if (returnTypeInfo.name === 'byte') descriptor += 'B';
          else if (returnTypeInfo.name === 'short') descriptor += 'S';
          else if (returnTypeInfo.name === 'void') descriptor += 'V';
          else descriptor += 'I'; // fallback
        } else if (returnTypeInfo._classData && returnTypeInfo._classData.ast && returnTypeInfo._classData.ast.classes[0]) {
          const returnClassName = returnTypeInfo._classData.ast.classes[0].className;
          descriptor += `L${returnClassName};`;
        } else {
          // Default to Object if we can't determine the type
          descriptor += 'Ljava/lang/Object;';
        }
      } else {
        descriptor += 'V';
      }
      
      // Create MethodHandle
      const handle = {
        type: 'java/lang/invoke/MethodHandle',
        kind: 'invokeVirtual',
        targetClass: className.replace(/\./g, '/'),
        targetMethodName: methodName,
        targetDescriptor: descriptor,
        targetMethod: null // Will be resolved at invoke time
      };
      
      if (jvm.verbose) {
        console.log(`Created MethodHandle for ${handle.targetClass}.${handle.targetMethodName}${handle.targetDescriptor}`);
      }
      
      return handle;
    }
  }
};
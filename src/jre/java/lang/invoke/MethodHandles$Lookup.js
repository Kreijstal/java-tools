module.exports = {
  super: "java/lang/Object",
  staticFields: {},
  staticMethods: {},
  methods: {
    "findStatic(Ljava/lang/Class;Ljava/lang/String;Ljava/lang/invoke/MethodType;)Ljava/lang/invoke/MethodHandle;":
      (jvm, lookup, args) => {
        const targetClass = args[0]; // Class object
        const methodName = args[1]; // String
        const methodType = args[2]; // MethodType object

        // Extract class name from Class object
        let className = "java/lang/String"; // Default assumption
        if (
          targetClass._classData &&
          targetClass._classData.ast &&
          targetClass._classData.ast.classes[0]
        ) {
          className = targetClass._classData.ast.classes[0].className;
        } else if (targetClass._className) {
          className = targetClass._className;
        } else if (targetClass.className) {
          className = targetClass.className;
        }

        // Build method descriptor from MethodType
        let descriptor = "(";
        if (methodType.parameterTypes && methodType.parameterTypes.length > 0) {
          for (const paramType of methodType.parameterTypes) {
            if (paramType.isPrimitive && paramType.name === "int") {
              descriptor += "I";
            } else if (paramType.isPrimitive && paramType.name === "long") {
              descriptor += "J";
            } else if (paramType.isPrimitive && paramType.name === "float") {
              descriptor += "F";
            } else if (paramType.isPrimitive && paramType.name === "double") {
              descriptor += "D";
            } else if (paramType.isPrimitive && paramType.name === "boolean") {
              descriptor += "Z";
            } else if (paramType.isPrimitive && paramType.name === "char") {
              descriptor += "C";
            } else if (paramType.isPrimitive && paramType.name === "byte") {
              descriptor += "B";
            } else if (paramType.isPrimitive && paramType.name === "short") {
              descriptor += "S";
            } else {
              // Object types
              let objectClass = "java/lang/Object";
              if (
                paramType._classData &&
                paramType._classData.ast &&
                paramType._classData.ast.classes[0]
              ) {
                objectClass = paramType._classData.ast.classes[0].className;
              }
              descriptor += `L${objectClass};`;
            }
          }
        }
        descriptor += ")";

        // Add return type
        if (methodType.returnType) {
          const returnTypeInfo = methodType.returnType;
          if (returnTypeInfo.isPrimitive) {
            if (returnTypeInfo.name === "int") descriptor += "I";
            else if (returnTypeInfo.name === "long") descriptor += "J";
            else if (returnTypeInfo.name === "float") descriptor += "F";
            else if (returnTypeInfo.name === "double") descriptor += "D";
            else if (returnTypeInfo.name === "boolean") descriptor += "Z";
            else if (returnTypeInfo.name === "char") descriptor += "C";
            else if (returnTypeInfo.name === "byte") descriptor += "B";
            else if (returnTypeInfo.name === "short") descriptor += "S";
            else if (returnTypeInfo.name === "void") descriptor += "V";
            else descriptor += "I"; // fallback
          } else if (
            returnTypeInfo._classData &&
            returnTypeInfo._classData.ast &&
            returnTypeInfo._classData.ast.classes[0]
          ) {
            const returnClassName =
              returnTypeInfo._classData.ast.classes[0].className;
            descriptor += `L${returnClassName};`;
          } else {
            // Default to Object if we can't determine the type
            descriptor += "Ljava/lang/Object;";
          }
        } else {
          descriptor += "V";
        }

        // Create MethodHandle
        const handle = {
          type: "java/lang/invoke/MethodHandle",
          kind: "invokeStatic",
          targetClass: className.replace(/\./g, "/"),
          targetMethodName: methodName,
          targetDescriptor: descriptor,
          targetMethod: null, // Will be resolved at invoke time
        };

        if (jvm.verbose) {
          console.log(
            `Created MethodHandle for ${handle.targetClass}.${handle.targetMethodName}${handle.targetDescriptor}`,
          );
        }

        return handle;
      },

    "findVirtual(Ljava/lang/Class;Ljava/lang/String;Ljava/lang/invoke/MethodType;)Ljava/lang/invoke/MethodHandle;":
      (jvm, lookup, args) => {
        const targetClass = args[0]; // Class object
        const methodName = args[1]; // String
        const methodType = args[2]; // MethodType object

        // Extract class name from Class object
        let className = "java/lang/String"; // Default assumption
        if (
          targetClass._classData &&
          targetClass._classData.ast &&
          targetClass._classData.ast.classes[0]
        ) {
          className = targetClass._classData.ast.classes[0].className;
        } else if (targetClass._className) {
          className = targetClass._className;
        } else if (targetClass.className) {
          className = targetClass.className;
        }

        // Build method descriptor from MethodType
        let descriptor = "(";
        if (methodType.parameterTypes && methodType.parameterTypes.length > 0) {
          for (const paramType of methodType.parameterTypes) {
            if (paramType.isPrimitive && paramType.name === "int") {
              descriptor += "I";
            } else if (paramType.isPrimitive && paramType.name === "long") {
              descriptor += "J";
            } else if (paramType.isPrimitive && paramType.name === "float") {
              descriptor += "F";
            } else if (paramType.isPrimitive && paramType.name === "double") {
              descriptor += "D";
            } else if (paramType.isPrimitive && paramType.name === "boolean") {
              descriptor += "Z";
            } else if (paramType.isPrimitive && paramType.name === "char") {
              descriptor += "C";
            } else if (paramType.isPrimitive && paramType.name === "byte") {
              descriptor += "B";
            } else if (paramType.isPrimitive && paramType.name === "short") {
              descriptor += "S";
            } else {
              // Object types
              let objectClass = "java/lang/Object";
              if (
                paramType._classData &&
                paramType._classData.ast &&
                paramType._classData.ast.classes[0]
              ) {
                objectClass = paramType._classData.ast.classes[0].className;
              }
              descriptor += `L${objectClass};`;
            }
          }
        }
        descriptor += ")";

        // Add return type
        if (methodType.returnType) {
          const returnTypeInfo = methodType.returnType;
          if (returnTypeInfo.isPrimitive) {
            if (returnTypeInfo.name === "int") descriptor += "I";
            else if (returnTypeInfo.name === "long") descriptor += "J";
            else if (returnTypeInfo.name === "float") descriptor += "F";
            else if (returnTypeInfo.name === "double") descriptor += "D";
            else if (returnTypeInfo.name === "boolean") descriptor += "Z";
            else if (returnTypeInfo.name === "char") descriptor += "C";
            else if (returnTypeInfo.name === "byte") descriptor += "B";
            else if (returnTypeInfo.name === "short") descriptor += "S";
            else if (returnTypeInfo.name === "void") descriptor += "V";
            else descriptor += "I"; // fallback
          } else if (
            returnTypeInfo._classData &&
            returnTypeInfo._classData.ast &&
            returnTypeInfo._classData.ast.classes[0]
          ) {
            const returnClassName =
              returnTypeInfo._classData.ast.classes[0].className;
            descriptor += `L${returnClassName};`;
          } else {
            // Default to Object if we can't determine the type
            descriptor += "Ljava/lang/Object;";
          }
        } else {
          descriptor += "V";
        }

        // Create MethodHandle
        const handle = {
          type: "java/lang/invoke/MethodHandle",
          kind: "invokeVirtual",
          targetClass: className.replace(/\./g, "/"),
          targetMethodName: methodName,
          targetDescriptor: descriptor,
          targetMethod: null, // Will be resolved at invoke time
        };

        if (jvm.verbose) {
          console.log(
            `Created MethodHandle for ${handle.targetClass}.${handle.targetMethodName}${handle.targetDescriptor}`,
          );
        }

        return handle;
      },

    "findGetter(Ljava/lang/Class;Ljava/lang/String;Ljava/lang/Class;)Ljava/lang/invoke/MethodHandle;":
      (jvm, lookup, args) => {
        const targetClass = args[0]; // Class object
        const fieldName = args[1]; // String
        const fieldType = args[2]; // Class object

        // Extract class name from Class object
        let className = "java/lang/String"; // Default assumption
        if (
          targetClass._classData &&
          targetClass._classData.ast &&
          targetClass._classData.ast.classes[0]
        ) {
          className = targetClass._classData.ast.classes[0].className;
        } else if (targetClass._className) {
          className = targetClass._className;
        } else if (targetClass.className) {
          className = targetClass.className;
        }

        // Build field descriptor from field type
        let descriptor = "";
        if (fieldType.isPrimitive) {
          if (fieldType.name === "int") descriptor = "I";
          else if (fieldType.name === "long") descriptor = "J";
          else if (fieldType.name === "float") descriptor = "F";
          else if (fieldType.name === "double") descriptor = "D";
          else if (fieldType.name === "boolean") descriptor = "Z";
          else if (fieldType.name === "char") descriptor = "C";
          else if (fieldType.name === "byte") descriptor = "B";
          else if (fieldType.name === "short") descriptor = "S";
          else descriptor = "I"; // fallback
        } else if (
          fieldType._classData &&
          fieldType._classData.ast &&
          fieldType._classData.ast.classes[0]
        ) {
          const fieldClassName = fieldType._classData.ast.classes[0].className;
          descriptor = `L${fieldClassName};`;
        } else {
          // Default to Object if we can't determine the type
          descriptor = "Ljava/lang/Object;";
        }

        // Create MethodHandle for field getter
        const handle = {
          type: "java/lang/invoke/MethodHandle",
          kind: "getField",
          targetClass: className.replace(/\./g, "/"),
          targetFieldName: fieldName,
          targetDescriptor: descriptor,
          targetField: null, // Will be resolved at invoke time
        };

        if (jvm.verbose) {
          console.log(
            `Created MethodHandle for getter ${handle.targetClass}.${handle.targetFieldName} (${handle.targetDescriptor})`,
          );
        }

        return handle;
      },

    "findSetter(Ljava/lang/Class;Ljava/lang/String;Ljava/lang/Class;)Ljava/lang/invoke/MethodHandle;":
      (jvm, lookup, args) => {
        const targetClass = args[0]; // Class object
        const fieldName = args[1]; // String
        const fieldType = args[2]; // Class object

        // Extract class name from Class object
        let className = "java/lang/String"; // Default assumption
        if (
          targetClass._classData &&
          targetClass._classData.ast &&
          targetClass._classData.ast.classes[0]
        ) {
          className = targetClass._classData.ast.classes[0].className;
        } else if (targetClass._className) {
          className = targetClass._className;
        } else if (targetClass.className) {
          className = targetClass.className;
        }

        // Build field descriptor from field type
        let descriptor = "";
        if (fieldType.isPrimitive) {
          if (fieldType.name === "int") descriptor = "I";
          else if (fieldType.name === "long") descriptor = "J";
          else if (fieldType.name === "float") descriptor = "F";
          else if (fieldType.name === "double") descriptor = "D";
          else if (fieldType.name === "boolean") descriptor = "Z";
          else if (fieldType.name === "char") descriptor = "C";
          else if (fieldType.name === "byte") descriptor = "B";
          else if (fieldType.name === "short") descriptor = "S";
          else descriptor = "I"; // fallback
        } else if (
          fieldType._classData &&
          fieldType._classData.ast &&
          fieldType._classData.ast.classes[0]
        ) {
          const fieldClassName = fieldType._classData.ast.classes[0].className;
          descriptor = `L${fieldClassName};`;
        } else {
          // Default to Object if we can't determine the type
          descriptor = "Ljava/lang/Object;";
        }

        // Create MethodHandle for field setter
        const handle = {
          type: "java/lang/invoke/MethodHandle",
          kind: "putField",
          targetClass: className.replace(/\./g, "/"),
          targetFieldName: fieldName,
          targetDescriptor: descriptor,
          targetField: null, // Will be resolved at invoke time
        };

        if (jvm.verbose) {
          console.log(
            `Created MethodHandle for setter ${handle.targetClass}.${handle.targetFieldName} (${handle.targetDescriptor})`,
          );
        }

        return handle;
      },
  },
};

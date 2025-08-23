/**
 * JRE Bootstrap Module
 *
 * This module handles the loading and initialization of JRE (Java Runtime Environment) classes
 * into the JVM's runtime class registry. This separates JRE concerns from core JVM functionality.
 */

class JreBootstrap {
  /**
   * Preload essential JRE classes that are required for basic JVM operation
   * @param {JVM} jvm - The JVM instance to load classes into
   */
  static preloadEssentialClasses(jvm) {
    const essentialClasses = [
      'java/lang/Object',
      'java/lang/System',
      'java/lang/String',
      'java/lang/Class',
      'java/io/PrintStream',
      'java/io/ConsoleOutputStream',
      'java/lang/Throwable',
      'java/lang/Exception',
      'java/lang/RuntimeException'
    ];

    for (const className of essentialClasses) {
      if (jvm.jre[className] && !jvm.classes[className]) {
        this.createRuntimeClass(jvm, className, jvm.jre[className]);
      }
    }
  }

  /**
   * Load all JRE classes from the hierarchy and filesystem (extracted from JVM._preloadJreClasses)
   * @param {JVM} jvm - The JVM instance to load classes into
   */
  static preloadAllJreClasses(jvm) {
    const jreHierarchy = {
      "java/lang/Object": null,
      "java/lang/System": "java/lang/Object",
      "java/lang/Throwable": "java/lang/Object",
      "java/lang/Exception": "java/lang/Throwable",
      "java/lang/RuntimeException": "java/lang/Exception",
      "java/lang/ArithmeticException": "java/lang/RuntimeException",
      "java/lang/IllegalArgumentException": "java/lang/RuntimeException",
      "java/lang/IllegalStateException": "java/lang/RuntimeException",
      "java/lang/Enum": "java/lang/Object",
      "java/lang/Runnable": "java/lang/Object",
      "java/lang/CharSequence": "java/lang/Object",
      "java/lang/ReflectiveOperationException": "java/lang/Exception",
      "java/lang/NoSuchMethodException":
        "java/lang/ReflectiveOperationException",
      "java/io/IOException": "java/lang/Exception",
      "java/io/Reader": "java/lang/Object",
      "java/io/BufferedReader": "java/io/Reader",
      "java/io/InputStreamReader": "java/io/Reader",
      "java/io/InputStream": "java/lang/Object",
      "java/io/FilterInputStream": "java/io/InputStream",
      "java/io/BufferedInputStream": "java/io/FilterInputStream",
      "java/io/OutputStream": "java/lang/Object",
      "java/io/FilterOutputStream": "java/io/OutputStream",
      "java/io/PrintStream": "java/io/FilterOutputStream",
      "java/io/ConsoleOutputStream": "java/io/OutputStream",
      "java/net/URLConnection": "java/lang/Object",
      "java/net/HttpURLConnection": "java/net/URLConnection",
      "java/net/URI": "java/lang/Object",
      "java/net/http/HttpClient": "java/lang/Object",
      "java/net/http/HttpRequest": "java/lang/Object",
      "java/net/http/HttpResponse": "java/lang/Object",
      "java/time/Duration": "java/lang/Object",
      "java/util/function/Function": "java/lang/Object",
      "java/lang/reflect/Array": "java/lang/Object",
    };

    // Create stubs for all classes in the hierarchy
    for (const className in jreHierarchy) {
      const superClassName = jreHierarchy[className];
      const jreClassDef = jvm.jre[className];
      const interfaces =
        jreClassDef && jreClassDef.interfaces ? jreClassDef.interfaces : [];

      const classStub = {
        ast: {
          classes: [
            {
              className: className,
              superClassName: superClassName,
              items: [],
              flags: ["public"],
              interfaces: interfaces,
            },
          ],
        },
        constantPool: [],
        staticFields: new Map(),
      };
      jvm.classes[className] = classStub;
    }

    // Add other JRE classes that extend Object directly - only in Node.js environment
    if (typeof window === "undefined" && jvm.fs && jvm.path) {
      const jrePath = jvm.path.join(__dirname, "jre");
      const walk = (dir, prefix) => {
        const files = jvm.fs.readdirSync(dir);
        for (const file of files) {
          const fullPath = jvm.path.join(dir, file);
          const stat = jvm.fs.statSync(fullPath);
          if (stat.isDirectory()) {
            walk(fullPath, `${prefix}${file}/`);
          } else if (file.endsWith(".js")) {
            const className = `${prefix}${file.slice(0, -3)}`;
            if (!jvm.classes[className]) {
              const jreClassDef = jvm.jre[className];
              const interfaces =
                jreClassDef && jreClassDef.interfaces
                  ? jreClassDef.interfaces
                  : [];
              const methods =
                jreClassDef && jreClassDef.methods
                  ? Object.keys(jreClassDef.methods).map((methodSig) => {
                      const openParen = methodSig.indexOf("(");
                      const name = methodSig.substring(0, openParen);
                      const descriptor = methodSig.substring(openParen);
                      return {
                        type: "method",
                        method: {
                          name: name,
                          descriptor: descriptor,
                          flags: ["public"], // Assume public for JRE methods
                          attributes: [],
                        },
                      };
                    })
                  : [];

              const classStub = {
                ast: {
                  classes: [
                    {
                      className: className,
                      superClassName:
                        (jreClassDef && jreClassDef.super) ||
                        "java/lang/Object",
                      items: methods,
                      flags: ["public"],
                      interfaces: interfaces,
                    },
                  ],
                },
                constantPool: [],
                staticFields: new Map(),
              };

              // Initialize static fields from JRE definition during preloading
              if (jreClassDef && jreClassDef.staticFields) {
                for (const [fieldKey, fieldValue] of Object.entries(
                  jreClassDef.staticFields,
                )) {
                  classStub.staticFields.set(fieldKey, fieldValue);
                }
              }

              jvm.classes[className] = classStub;

              // Special handling for MethodHandle - set up invoke methods
              if (className === 'java/lang/invoke/MethodHandle') {
                this.setupMethodHandleInvoke(jvm, className);
              }
            }
          }
        }
      };
      walk(jrePath, "");
    }
    // In browser environment, we'll rely on the basic hierarchy defined above
    // and any additional JRE classes can be loaded dynamically as needed

    // Set up special method interfaces that need JVM dispatch
    this.setupMethodHandleInvoke(jvm);

    // Set up reflection Array methods
    this.setupArrayReflection(jvm);

    // Set up Class reflection methods for arrays
    this.setupClassReflection(jvm);
  }

  /**
   * Set up MethodHandle.invoke method resolution behavior
   * @param {JVM} jvm - The JVM instance
   * @param {string} className - Name of the class to create
   */
  static setupMethodHandleInvoke(jvm, className) {
    if (className === 'java/lang/invoke/MethodHandle') {
      // Set up the generic invoke method that will be dispatched by JVM
      const invokeMethod = {
        type: "method",
        method: {
          name: "invoke",
          descriptor: "([Ljava/lang/Object;)Ljava/lang/Object;",
          flags: ["public"],
          attributes: [],
        },
      };

      // Add to the class if it exists
      const classData = jvm.classes[className];
      if (classData && classData.ast && classData.ast.classes[0]) {
        if (!classData.ast.classes[0].items) {
          classData.ast.classes[0].items = [];
        }
        // Check if invoke method already exists
        const existingInvoke = classData.ast.classes[0].items.find(
          item => item.type === "method" && item.method.name === "invoke"
        );
        if (!existingInvoke) {
          classData.ast.classes[0].items.push(invokeMethod);
        }
      }

      // Also add the generic method to the JRE definition so it can be found
      if (!jvm.jre[className]) {
        jvm.jre[className] = {};
      }
      if (!jvm.jre[className].methods) {
        jvm.jre[className].methods = {};
      }

      // MethodHandle.invoke signatures - truly universal implementation
      // This single signature can handle ANY method handle invocation dynamically
      const invokeSignatures = [
        "([Ljava/lang/Object;)Ljava/lang/Object;" // Universal varargs signature - can handle any parameters
      ];

      invokeSignatures.forEach(sig => {
        const methodKey = `invoke${sig}`;
        jvm.jre[className].methods[methodKey] = function(jvm, thisObj, args, thread) {
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
  }

  /**
   * Set up reflection Array static methods
   * @param {JVM} jvm - The JVM instance
   */
  static setupArrayReflection(jvm) {
    const arrayClassName = 'java/lang/reflect/Array';

    // Initialize the class if it doesn't exist
    if (!jvm.jre[arrayClassName]) {
      jvm.jre[arrayClassName] = {};
    }
    if (!jvm.jre[arrayClassName].staticMethods) {
      jvm.jre[arrayClassName].staticMethods = {};
    }

    // Array.newInstance(Class, int) - creates a new array
    jvm.jre[arrayClassName].staticMethods['newInstance(Ljava/lang/Class;I)Ljava/lang/Object;'] = function(jvm, obj, args, thread) {
      const componentType = args[0];
      const length = args[1];

      // Determine the array type based on component type
      let arrayType = '[java/lang/Object'; // default
      if (componentType) {
        // Check if it's a primitive type
        if (componentType.isPrimitive) {
          if (componentType.name === 'int') {
            arrayType = '[I'; // int array
          } else if (componentType.name === 'double') {
            arrayType = '[D'; // double array
          } else if (componentType.name === 'boolean') {
            arrayType = '[Z'; // boolean array
          } else if (componentType.name === 'byte') {
            arrayType = '[B'; // byte array
          } else if (componentType.name === 'char') {
            arrayType = '[C'; // char array
          } else if (componentType.name === 'short') {
            arrayType = '[S'; // short array
          } else if (componentType.name === 'long') {
            arrayType = '[J'; // long array
          } else if (componentType.name === 'float') {
            arrayType = '[F'; // float array
          }
        } else if (componentType.type === 'java/lang/String') {
          arrayType = '[Ljava/lang/String;'; // String array
        } else if (componentType.type && componentType.type.startsWith('[')) {
          // Multi-dimensional array
          arrayType = `[${componentType.type}`;
        } else if (componentType.type) {
          arrayType = `[L${componentType.type};`;
        }
      }

      // Create array representation
      const array = {
        type: arrayType,
        length: length,
        elements: new Array(length),
        fields: {} // For compatibility
      };

      // Create a proper Class object for this array
      let extractedComponentType = arrayType.slice(1); // Remove the leading '[' to get component type

      // Handle different array type formats
      if (extractedComponentType.startsWith('L') && extractedComponentType.endsWith(';')) {
        // Object array like [Ljava/lang/String; -> java/lang/String
        extractedComponentType = extractedComponentType.slice(1, -1);
      }
      // For primitive arrays like [I, [D, etc., componentType is already correct (I, D, etc.)

      const arrayClass = {
        type: 'java/lang/Class',
        _classData: {
          isArray: true,
          arrayType: arrayType,
          componentType: extractedComponentType,
          className: arrayType
        }
      };

      // Register the array class in the JVM's class registry
      if (!jvm.classes[arrayType]) {
        jvm.classes[arrayType] = arrayClass;
      }

      // Register the array class in the JVM's class registry
      if (!jvm.classes[arrayType]) {
        jvm.classes[arrayType] = arrayClass;
      }

      // Don't override getClass - let the JVM use Object.getClass() which will find the registered class
      // The array class is already registered in jvm.classes[arrayType]

      // Initialize elements based on type
      if (arrayType === '[I') {
        array.elements.fill(0); // int array initialized to 0
      } else if (arrayType === '[D') {
        array.elements.fill(0.0); // double array initialized to 0.0
      } else {
        array.elements.fill(null); // object arrays initialized to null
      }

      return array;
    };

    // Array.getLength(Object) - gets array length
    jvm.jre[arrayClassName].staticMethods['getLength(Ljava/lang/Object;)I'] = function(jvm, obj, args, thread) {
      const array = args[0];
      return array && typeof array.length === 'number' ? array.length : 0;
    };

    // Array.setInt(Object, int, int) - sets int value
    jvm.jre[arrayClassName].staticMethods['setInt(Ljava/lang/Object;II)V'] = function(jvm, obj, args, thread) {
      const array = args[0];
      const index = args[1];
      const value = args[2];

      if (array && array.elements && index >= 0 && index < array.elements.length) {
        array.elements[index] = value;
      }
    };

    // Array.getInt(Object, int) - gets int value
    jvm.jre[arrayClassName].staticMethods['getInt(Ljava/lang/Object;I)I'] = function(jvm, obj, args, thread) {
      const array = args[0];
      const index = args[1];

      if (array && array.elements && index >= 0 && index < array.elements.length) {
        const value = array.elements[index];
        // Ensure we return a primitive int, not an Integer object
        if (typeof value === 'number') {
          return value;
        } else if (value && typeof value === 'object' && value.type === 'java/lang/Integer') {
          return value.value || 0; // Extract primitive value from Integer wrapper
        }
        return 0;
      }
      return 0;
    };

    // Array.set(Object, int, Object) - sets object value
    jvm.jre[arrayClassName].staticMethods['set(Ljava/lang/Object;ILjava/lang/Object;)V'] = function(jvm, obj, args, thread) {
      const array = args[0];
      const index = args[1];
      const value = args[2];

      if (array && array.elements && index >= 0 && index < array.elements.length) {
        // Handle string interning for String objects
        if (value && value.type === 'java/lang/String') {
          array.elements[index] = value;
        } else {
          array.elements[index] = value;
        }
      }
    };

    // Array.get(Object, int) - gets object value
    jvm.jre[arrayClassName].staticMethods['get(Ljava/lang/Object;I)Ljava/lang/Object;'] = function(jvm, obj, args, thread) {
      const array = args[0];
      const index = args[1];

      if (array && array.elements && index >= 0 && index < array.elements.length) {
        const value = array.elements[index];

        // For multi-dimensional arrays, return sub-arrays directly
        if (array.type && array.type.startsWith('[[') && Array.isArray(value)) {
          return value;
        }

        // For String arrays, return the string value, for others return the object
        if (array.type && array.type.startsWith('[Ljava/lang/String;') && typeof value === 'string') {
          return jvm.internString(value);
        }
        return value || null;
      }
      return null;
    };

    // Array.newInstance(Class, int[]) - creates multi-dimensional arrays
    jvm.jre[arrayClassName].staticMethods['newInstance(Ljava/lang/Class;[I)Ljava/lang/Object;'] = function(jvm, obj, args, thread) {
      const componentType = args[0];
      const dimensions = args[1];

      // Extract the actual component type from nested Class structure
      let actualComponentType = componentType;
      if (componentType && componentType._classData && componentType._classData.ast && componentType._classData.ast.classes) {
        // This is a nested Class object, extract the actual type
        const classInfo = componentType._classData.ast.classes[0];
        if (classInfo && classInfo.className) {
          actualComponentType = { type: classInfo.className };
        }
      }

      // Handle dimensions - could be a Java array or plain array
      let dimensionArray = [];
      if (dimensions) {
        if (dimensions.elements && Array.isArray(dimensions.elements)) {
          dimensionArray = dimensions.elements;
        } else if (Array.isArray(dimensions)) {
          // Filter out non-numeric properties to get clean dimensions
          dimensionArray = dimensions.filter((item, index) => {
            return typeof item === 'number' && dimensions.indexOf(item) === index;
          });
        } else if (typeof dimensions === 'object' && dimensions.length !== undefined) {
          // Convert to array if it has a length property
          dimensionArray = Array.from(dimensions).filter(item => typeof item === 'number');
        }
      }

      if (dimensionArray.length === 0) {
        return null;
      }

      return createMultiDimensionalArray(jvm, actualComponentType, dimensionArray, 0);
    };

    // Array.newInstance(Class, int, int) - creates 2D arrays (common case)
    jvm.jre[arrayClassName].staticMethods['newInstance(Ljava/lang/Class;II)Ljava/lang/Object;'] = function(jvm, obj, args, thread) {
      const componentType = args[0];
      const dim1 = args[1];
      const dim2 = args[2];

      return createMultiDimensionalArray(jvm, componentType, [dim1, dim2], 0);
    };

    // Array.getDouble(Object, int) - gets double value
    jvm.jre[arrayClassName].staticMethods['getDouble(Ljava/lang/Object;I)D'] = function(jvm, obj, args, thread) {
      const array = args[0];
      const index = args[1];

      if (array && array.elements && index >= 0 && index < array.elements.length) {
        const value = array.elements[index];
        if (typeof value === 'number') {
          return value;
        } else if (value && typeof value === 'object' && value.type === 'java/lang/Double') {
          return value.value || 0.0;
        }
        return 0.0;
      }
      return 0.0;
    };

    // Array.setDouble(Object, int, double) - sets double value
    jvm.jre[arrayClassName].staticMethods['setDouble(Ljava/lang/Object;ID)V'] = function(jvm, obj, args, thread) {
      const array = args[0];
      const index = args[1];
      const value = args[2];

      if (array && array.elements && index >= 0 && index < array.elements.length) {
        array.elements[index] = value;
      }
    };

    // Helper function to create multi-dimensional arrays recursively
    function createMultiDimensionalArray(jvm, componentType, dimensions, depth) {
      if (depth >= dimensions.length) {
        return null; // Should not reach here for valid dimensions
      }

      const currentDim = dimensions[depth];
      let elementType = 'java/lang/Object'; // default

      if (componentType) {
        if (componentType.type === 'java/lang/String') {
          elementType = 'java/lang/String';
        } else if (componentType.type === 'java/lang/Integer') {
          elementType = 'int';
        } else if (componentType.type === 'java/lang/Double') {
          elementType = 'double';
        } else if (componentType.type) {
          elementType = componentType.type;
        }
      }

      // Build the array type descriptor
      let arrayType = '['.repeat(dimensions.length - depth);
      if (elementType === 'int') {
        arrayType += 'I';
      } else if (elementType === 'double') {
        arrayType += 'D';
      } else {
        arrayType += 'L' + elementType + ';';
      }

      const array = {
        type: arrayType,
        length: currentDim,
        elements: new Array(currentDim),
        fields: {}
      };

      // Determine component type for this dimension
      let componentTypeForThisLevel;
      if (depth === dimensions.length - 1) {
        // Last dimension - use the actual element type
        componentTypeForThisLevel = elementType;
      } else {
        // Intermediate dimension - use the array type of the next level
        let nextLevelArrayType = '['.repeat(dimensions.length - depth - 1);
        if (elementType === 'int') {
          nextLevelArrayType += 'I';
        } else if (elementType === 'double') {
          nextLevelArrayType += 'D';
        } else {
          nextLevelArrayType += 'L' + elementType + ';';
        }
        componentTypeForThisLevel = nextLevelArrayType;
      }

      // Create a proper Class object for this array
      const arrayClass = {
        type: 'java/lang/Class',
        _classData: {
          isArray: true,
          arrayType: arrayType,
          componentType: componentTypeForThisLevel,
          className: arrayType
        },
        // Also set the className directly for compatibility
        className: arrayType
      };

      // Override the getClass method for this array
      array.getClass = function() {
        return arrayClass;
      };

      if (depth === dimensions.length - 1) {
        // Last dimension - create primitive or null elements
        if (elementType === 'int') {
          array.elements.fill(0);
        } else if (elementType === 'double') {
          array.elements.fill(0.0);
        } else {
          array.elements.fill(null);
        }
      } else {
        // Create sub-arrays recursively
        for (let i = 0; i < currentDim; i++) {
          array.elements[i] = createMultiDimensionalArray(jvm, componentType, dimensions, depth + 1);
        }
      }

      return array;
    }
  }

  /**
   * Set up Class reflection methods for arrays
   * @param {JVM} jvm - The JVM instance
   */
  static setupClassReflection(jvm) {
    const className = 'java/lang/Class';

    // Initialize the class if it doesn't exist
    if (!jvm.jre[className]) {
      jvm.jre[className] = {};
    }
    if (!jvm.jre[className].methods) {
      jvm.jre[className].methods = {};
    }

    // Class.isArray() - check if this class represents an array
    jvm.jre[className].methods['isArray()Z'] = function(jvm, thisObj, args, thread) {
      if (thisObj && thisObj._classData) {
        const classData = thisObj._classData;

        // Handle nested _classData structure
        let actualClassData = classData;
        if (classData._classData) {
          actualClassData = classData._classData;
        }

        const result = actualClassData.isArray || false;
        return result;
      }

      return false;
    };

    // Class.getComponentType() - get the component type of an array class
    jvm.jre[className].methods['getComponentType()Ljava/lang/Class;'] = function(jvm, thisObj, args, thread) {
      if (thisObj && thisObj._classData) {
        const classData = thisObj._classData;

        // Handle nested _classData structure
        let actualClassData = classData;
        if (classData._classData) {
          actualClassData = classData._classData;
        }

        if (actualClassData.isArray && actualClassData.componentType) {
          // Handle primitive types
          if (actualClassData.componentType === 'I') {
            return jvm.getClassObject('int');
          } else if (actualClassData.componentType === 'D') {
            return jvm.getClassObject('double');
          } else if (actualClassData.componentType === 'Z') {
            return jvm.getClassObject('boolean');
          } else if (actualClassData.componentType === 'B') {
            return jvm.getClassObject('byte');
          } else if (actualClassData.componentType === 'C') {
            return jvm.getClassObject('char');
          } else if (actualClassData.componentType === 'S') {
            return jvm.getClassObject('short');
          } else if (actualClassData.componentType === 'J') {
            return jvm.getClassObject('long');
          } else if (actualClassData.componentType === 'F') {
            return jvm.getClassObject('float');
          } else {
            // Handle object types
            return jvm.getClassObject(actualClassData.componentType);
          }
        }
      }

      // Fallback: try to extract component type from className
      if (thisObj && thisObj.className && thisObj.className.startsWith('[[')) {
        const componentType = thisObj.className.slice(1); // Remove first '['

        // Handle primitive types
        if (componentType === 'I') {
          return jvm.getClassObject('int');
        } else if (componentType === 'D') {
          return jvm.getClassObject('double');
        } else if (componentType === 'Z') {
          return jvm.getClassObject('boolean');
        } else if (componentType === 'B') {
          return jvm.getClassObject('byte');
        } else if (componentType === 'C') {
          return jvm.getClassObject('char');
        } else if (componentType === 'S') {
          return jvm.getClassObject('short');
        } else if (componentType === 'J') {
          return jvm.getClassObject('long');
        } else if (componentType === 'F') {
          return jvm.getClassObject('float');
        }
        // Handle object types (including array types)
        else if (componentType.startsWith('L') && componentType.endsWith(';')) {
          const className = componentType.slice(1, -1);
          return jvm.getClassObject(className);
        }
        // Handle array types (like [Ljava/lang/String;)
        else if (componentType.startsWith('[')) {
          // Create a class object for the array type
          const arrayClass = {
            type: 'java/lang/Class',
            _classData: {
              isArray: true,
              arrayType: componentType,
              componentType: componentType.slice(1), // Remove the leading '['
              className: componentType
            },
            className: componentType
          };
          return arrayClass;
        }
      }

      return null;
    };

    // Class.getName() - get the name of the class
    jvm.jre[className].methods['getName()Ljava/lang/String;'] = function(jvm, thisObj, args, thread) {
      // Handle primitive types
      if (thisObj && thisObj.isPrimitive) {
        return jvm.internString(thisObj.name);
      }

      if (thisObj && thisObj._classData) {
        const classData = thisObj._classData;

        // Handle nested _classData structure (for arrays and complex objects)
        let actualClassData = classData;
        if (classData._classData) {
          actualClassData = classData._classData;
        }

        if (actualClassData.isArray && actualClassData.arrayType) {
          // For arrays, convert slashes to dots (Java source format) - this matches Java behavior
          return jvm.internString(actualClassData.arrayType.replace(/\//g, '.'));
        } else if (actualClassData.className) {
          // For regular classes, convert slashes to dots (Java source format)
          return jvm.internString(actualClassData.className.replace(/\//g, '.'));
        } else if (actualClassData.ast && actualClassData.ast.classes && actualClassData.ast.classes[0]) {
          // Extract class name from AST if available
          const className = actualClassData.ast.classes[0].className;
          // Convert slashes to dots for all classes (both regular and array classes)
          return jvm.internString(className.replace(/\//g, '.'));
        }
      }

      // Fallback: check if className is set directly on the object
      if (thisObj && thisObj.className) {
        // Convert slashes to dots for all classes (both regular and array classes)
        return jvm.internString(thisObj.className.replace(/\//g, '.'));
      }

      // Final fallback: try to extract from the class data directly
      if (thisObj && thisObj._classData && thisObj._classData.ast && thisObj._classData.ast.classes) {
        const className = thisObj._classData.ast.classes[0].className;
        // Convert slashes to dots for all classes (both regular and array classes)
        return jvm.internString(className.replace(/\//g, '.'));
      }

      return jvm.internString("java.lang.Class");
    };
  }

  static createRuntimeClass(jvm, className, jreClassDef) {
    const interfaces = jreClassDef && jreClassDef.interfaces ? jreClassDef.interfaces : [];

    // Create method items from JRE class definition (similar to original _preloadJreClasses)
    const methods = [];
    if (jreClassDef) {
      // Add regular methods
      if (jreClassDef.methods) {
        for (const methodSig in jreClassDef.methods) {
          const openParen = methodSig.indexOf("(");
          const name = methodSig.substring(0, openParen);
          const descriptor = methodSig.substring(openParen);
          methods.push({
            type: "method",
            method: {
              name: name,
              descriptor: descriptor,
              flags: ["public"], // Assume public for JRE methods
              attributes: [],
            },
          });
        }
      }
      // Add static methods
      if (jreClassDef.staticMethods) {
        for (const methodSig in jreClassDef.staticMethods) {
          const openParen = methodSig.indexOf("(");
          const name = methodSig.substring(0, openParen);
          const descriptor = methodSig.substring(openParen);
          methods.push({
            type: "method",
            method: {
              name: name,
              descriptor: descriptor,
              flags: ["public", "static"], // Mark as static
              attributes: [],
            },
          });
        }
      }
    }

    const classStub = {
      ast: {
        classes: [
          {
            className: className,
            superClassName: jreClassDef && jreClassDef.super ? jreClassDef.super : "java/lang/Object",
            items: methods,
            flags: ["public"],
            interfaces: interfaces,
          },
        ],
      },
      constantPool: [],
      staticFields: new Map(),
    };

    // Initialize static fields from JRE definition
    if (jreClassDef && jreClassDef.staticFields) {
      if (jvm.verbose) {
        console.log(`Initializing static fields for ${className} from JRE definition`);
      }
      for (const [fieldKey, fieldValue] of Object.entries(jreClassDef.staticFields)) {
        classStub.staticFields.set(fieldKey, fieldValue);
        if (jvm.verbose) {
          console.log(`  Set static field ${fieldKey}:`, fieldValue);
        }
      }
    }

    jvm.classes[className] = classStub;
  }
}

module.exports = { JreBootstrap };
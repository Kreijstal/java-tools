module.exports = {
  new: async (frame, instruction, jvm, thread) => {
    const className = instruction.arg;

    const wasFramePushed = await jvm.initializeClassIfNeeded(className, thread);
    if (wasFramePushed) {
      frame.pc--;
      return;
    }

    try {
      jvm.loadClassByName(className);
    } catch (e) {
      if (e.code === 'ENOENT') {
        throw {
          type: 'java/lang/NoClassDefFoundError',
          message: className,
        };
      }
      throw e;
    }

    const fields = {};
    let currentClassName = className;
    while (currentClassName) {
      const currentClassData = jvm.classes[currentClassName];
      if (currentClassData) {
        const classFields = currentClassData.ast.classes[0].items.filter(item => item.type === 'field');
        for (const field of classFields) {
          const descriptor = field.field.descriptor;
          let defaultValue = null;
          if (descriptor === 'I' || descriptor === 'B' || descriptor === 'S' || descriptor === 'Z' || descriptor === 'C') {
            defaultValue = 0;
          } else if (descriptor === 'J') {
            defaultValue = BigInt(0);
          } else if (descriptor === 'F' || descriptor === 'D') {
            defaultValue = 0.0;
          }
          fields[`${currentClassName}.${field.field.name}`] = defaultValue;
        }
        const superClassName = currentClassData.ast.classes[0].superClassName;
        if (superClassName) {
            jvm.loadClassByName(superClassName);
        }
        currentClassName = superClassName;
      } else {
        currentClassName = null;
      }
    }

    const objRef = {
      type: className,
      fields,
      hashCode: jvm.nextHashCode++,
      isLocked: false,
      lockOwner: null,
      lockCount: 0,
      waitSet: [],
    };
    
    // Add JavaScript toString method that calls Java toString
    objRef.toString = function() {
      try {
        // Try to find toString method in the class hierarchy
        let currentType = this.type;
        let toStringMethod = null;
        
        // First check if it's a JRE class
        toStringMethod = jvm._jreFindMethod(currentType, 'toString', '()Ljava/lang/String;');
        
        // If not found, check parent classes
        if (!toStringMethod) {
          const classData = jvm.classes[currentType];
          if (classData && classData.ast && classData.ast.classes[0].superClassName) {
            const superClassName = classData.ast.classes[0].superClassName;
            toStringMethod = jvm._jreFindMethod(superClassName, 'toString', '()Ljava/lang/String;');
          }
        }
        
        if (toStringMethod) {
          const result = toStringMethod(jvm, this, []);
          return (result && result.value !== undefined) ? result.value : this.type.split('/').pop();
        }
        return this.type.split('/').pop();
      } catch (e) {
        return this.type.split('/').pop();
      }
    };
    
    frame.stack.push(objRef);
  },

  monitorenter: (frame, instruction, jvm, thread) => {
    const objRef = frame.stack.peek();
    if (!objRef) {
        throw new Error('NullPointerException in monitorenter');
    }

    if (!objRef.isLocked) {
      objRef.isLocked = true;
      objRef.lockOwner = thread.id;
      objRef.lockCount = 1;
      frame.stack.pop();
    } else if (objRef.lockOwner === thread.id) {
      objRef.lockCount++;
      frame.stack.pop();
    } else {
      thread.status = 'BLOCKED';
      thread.blockingOn = objRef;
      frame.pc--;
    }
  },

  monitorexit: (frame, instruction, jvm, thread) => {
    const objRef = frame.stack.pop();
     if (!objRef) {
        throw new Error('NullPointerException in monitorexit');
    }
    if (objRef.lockOwner !== thread.id) {
        throw new Error('IllegalMonitorStateException');
    }

    objRef.lockCount--;
    if (objRef.lockCount === 0) {
      objRef.isLocked = false;
      objRef.lockOwner = null;
    }
  },

  getfield: (frame, instruction, jvm) => {
    const [_, className, [fieldName, descriptor]] = instruction.arg;
    const objRef = frame.stack.pop();
    if (objRef === null) {
      throw new Error('NullPointerException');
    }
    const value = objRef.fields[`${className}.${fieldName}`];
    frame.stack.push(value);
  },

  putfield: (frame, instruction, jvm) => {
    const [_, className, [fieldName, descriptor]] = instruction.arg;
    const value = frame.stack.pop();
    const objRef = frame.stack.pop();
    if (objRef === null) {
      throw new Error('NullPointerException');
    }
    objRef.fields[`${className}.${fieldName}`] = value;
  },

  getstatic: async (frame, instruction, jvm, thread) => {
    const [_, className, [fieldName, descriptor]] = instruction.arg;

    const wasFramePushed = await jvm.initializeClassIfNeeded(className, thread);
    if (wasFramePushed) {
      frame.pc--; // Re-run this instruction after <clinit> is done.
      return;
    }

    const classData = jvm.classes[className];
    if (classData && classData.staticFields) {
      const fieldKey = `${fieldName}:${descriptor}`;
      if (classData.staticFields.has(fieldKey)) {
        frame.stack.push(classData.staticFields.get(fieldKey));
        return;
      }
    }

    throw new Error(`Unresolved static field: ${className}.${fieldName}`);
  },

  

  putstatic: async (frame, instruction, jvm, thread) => {
    const [_, className, [fieldName, descriptor]] = instruction.arg;
    const value = frame.stack.pop();

    const wasFramePushed = await jvm.initializeClassIfNeeded(className, thread);
    if (wasFramePushed) {
      frame.pc--; // Re-run this instruction after <clinit> is done.
      return;
    }

    const classData = jvm.classes[className];
    if (classData && classData.staticFields) {
      const fieldKey = `${fieldName}:${descriptor}`;
      classData.staticFields.set(fieldKey, value);
      return;
    }

    throw new Error(`Unsupported putstatic: ${className}.${fieldName}`);
  },

  arraylength: (frame, instruction, jvm) => {
    const arrayRef = frame.stack.pop();
    if (arrayRef === null) {
      throw {
        type: 'java/lang/NullPointerException',
        message: 'Attempted to get length of null array'
      };
    }
    const length = arrayRef.length;
    frame.stack.push(length);
  },
  aaload: (frame, instruction, jvm) => {
    const index = frame.stack.pop();
    const arrayRef = frame.stack.pop();
    if (arrayRef === null) {
      throw {
        type: 'java/lang/NullPointerException',
        message: 'Attempted to access null array'
      };
    }
    const value = arrayRef[index];
    frame.stack.push(value);
  },
  iaload: (frame, instruction, jvm) => {
    const index = frame.stack.pop();
    const arrayRef = frame.stack.pop();
    if (arrayRef === null) {
      throw {
        type: 'java/lang/NullPointerException',
        message: 'Attempted to access null array'
      };
    }
    const value = arrayRef[index];
    frame.stack.push(value);
  },
  aastore: (frame, instruction, jvm) => {
    const value = frame.stack.pop();
    const index = frame.stack.pop();
    const arrayRef = frame.stack.pop();
    if (arrayRef === null) {
      throw {
        type: 'java/lang/NullPointerException',
        message: 'Attempted to store to null array'
      };
    }
    arrayRef[index] = value;
  },
  iastore: (frame, instruction, jvm) => {
    const value = frame.stack.pop();
    const index = frame.stack.pop();
    const arrayRef = frame.stack.pop();
    if (arrayRef === null) {
      throw {
        type: 'java/lang/NullPointerException',
        message: 'Attempted to store to null array'
      };
    }
    arrayRef[index] = value;
  },
  anewarray: (frame, instruction, jvm) => {
    const count = frame.stack.pop();
    const elementType = instruction.arg;
    const array = new Array(count).fill(null);
    
    // Set array type for proper runtime behavior
    array.type = `[L${elementType};`;
    array.elementType = elementType;
    array.length = count;
    array.hashCode = jvm.nextHashCode++;
    
    frame.stack.push(array);
  },

  instanceof: (frame, instruction, jvm) => {
    const targetClassName = instruction.arg;
    const objRef = frame.stack.pop();

    if (objRef === null) {
      frame.stack.push(0);
      return;
    }

    const isInstanceOf = (className, target) => {
      if (!className) return false;
      if (className === target) return true;

      const classData = jvm.classes[className];
      if (!classData) return false;

      // Check superclass
      if (isInstanceOf(classData.ast.classes[0].superClassName, target)) {
        return true;
      }

      // Check interfaces
      const interfaces = classData.ast.classes[0].interfaces;
      if (interfaces) {
        for (const iface of interfaces) {
          if (isInstanceOf(iface, target)) {
            return true;
          }
        }
      }
      return false;
    };

    if (isInstanceOf(objRef.type, targetClassName)) {
      frame.stack.push(1);
    } else {
      frame.stack.push(0);
    }
  },

  multianewarray: (frame, instruction, jvm) => {
    const [className, dimensions] = instruction.arg;
    const counts = [];
    for (let i = 0; i < dimensions; i++) {
      counts.unshift(frame.stack.pop());
    }

    const createMultiArray = (dims) => {
      const count = dims.shift();
      const arr = new Array(count).fill(null);
      if (dims.length > 0) {
        for (let i = 0; i < count; i++) {
          arr[i] = createMultiArray([...dims]);
        }
      }
      return arr;
    };

    const newArray = createMultiArray(counts);
    frame.stack.push(newArray);
  },

  checkcast: (frame, instruction, jvm) => {
    const targetClassName = instruction.arg;
    const objRef = frame.stack.peek(); // Don't pop, just peek

    if (objRef === null) {
      return; // null can be cast to anything
    }

    let currentClassName = objRef.type;
    while (currentClassName) {
      if (currentClassName === targetClassName) {
        return; // Cast is valid
      }
      const classData = jvm.classes[currentClassName];
      if (!classData) {
        // This should not happen if classes are loaded correctly
        throw new Error('ClassCastException');
      }

      const interfaces = classData.ast.classes[0].interfaces;
      if (interfaces && interfaces.length > 0) {
        const interfaceQueue = [...interfaces];
        while (interfaceQueue.length > 0) {
          const interfaceName = interfaceQueue.shift();
          if (interfaceName === targetClassName) {
            return; // Cast is valid
          }
          const interfaceData = jvm.classes[interfaceName];
          if (interfaceData && interfaceData.ast.classes[0].interfaces) {
            interfaceQueue.push(...interfaceData.ast.classes[0].interfaces);
          }
        }
      }

      currentClassName = classData.ast.classes[0].superClassName;
    }

    // If we get here, the cast is invalid
    throw { type: 'java/lang/ClassCastException', message: `${objRef.type} cannot be cast to ${targetClassName}` };
  },

  newarray: (frame, instruction, jvm) => {
    const count = frame.stack.pop();
    const atype = instruction.arg;
    
    if (count < 0) {
      throw new Error('NegativeArraySizeException');
    }
    
    // Create array based on type name
    let array;
    switch (atype) {
      case 'boolean':
      case 'byte':
      case 'short':
      case 'int':
        array = new Array(count).fill(0);
        break;
      case 'long':
        array = new Array(count).fill(BigInt(0));
        break;
      case 'float':
      case 'double':
        array = new Array(count).fill(0.0);
        break;
      case 'char':
        array = new Array(count).fill(0); // char as int
        break;
      default:
        throw new Error(`Unsupported array type: ${atype}`);
    }
    
    // Set array type for proper runtime behavior
    array.type = 'array';
    array.elementType = atype;
    
    frame.stack.push(array);
  },
};

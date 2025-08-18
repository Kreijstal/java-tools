module.exports = {
  new: (frame, instruction, jvm) => {
    const className = instruction.arg;
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
          // TODO: Use correct default values based on field descriptor
          fields[`${currentClassName}.${field.field.name}`] = null;
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

  getstatic: (frame, instruction, jvm) => {
    const [_, className, [fieldName, descriptor]] = instruction.arg;

    const field = jvm._jreFindStaticField(className, fieldName, descriptor);
    if (field) {
      frame.stack.push(field);
    } else {
      throw new Error(`Unsupported getstatic: ${className}.${fieldName}`);
    }
  },
  arraylength: (frame, instruction, jvm) => {
    const arrayRef = frame.stack.pop();
    if (arrayRef === null) {
      throw new Error('NullPointerException');
    }
    const length = arrayRef.length;
    frame.stack.push(length);
  },
  aaload: (frame, instruction, jvm) => {
    const index = frame.stack.pop();
    const arrayRef = frame.stack.pop();
    if (arrayRef === null) {
      throw new Error('NullPointerException');
    }
    const value = arrayRef[index];
    frame.stack.push(value);
  },
  aastore: (frame, instruction, jvm) => {
    const value = frame.stack.pop();
    const index = frame.stack.pop();
    const arrayRef = frame.stack.pop();
    if (arrayRef === null) {
      throw new Error('NullPointerException');
    }
    arrayRef[index] = value;
  },
  anewarray: (frame, instruction, jvm) => {
    const count = frame.stack.pop();
    const array = new Array(count).fill(null);
    frame.stack.push(array);
  },

  instanceof: (frame, instruction, jvm) => {
    const targetClassName = instruction.arg;
    const objRef = frame.stack.pop();

    if (objRef === null) {
      frame.stack.push(0); // null is not an instance of anything
      return;
    }

    let currentClassName = objRef.type;
    while (currentClassName) {
      if (currentClassName === targetClassName) {
        frame.stack.push(1); // Found a match
        return;
      }

      const classData = jvm.classes[currentClassName];
      if (!classData) {
        frame.stack.push(0); // Should not happen if classes are loaded correctly
        return;
      }

      const interfaces = classData.ast.classes[0].interfaces;
      if (interfaces && interfaces.length > 0) {
        const interfaceQueue = [...interfaces];
        while (interfaceQueue.length > 0) {
          const interfaceName = interfaceQueue.shift();
          if (interfaceName === targetClassName) {
            frame.stack.push(1);
            return;
          }
          const interfaceData = jvm.classes[interfaceName];
          if (interfaceData && interfaceData.ast.classes[0].interfaces) {
            interfaceQueue.push(...interfaceData.ast.classes[0].interfaces);
          }
        }
      }
      currentClassName = classData.ast.classes[0].superClassName;
    }

    frame.stack.push(0); // No match found in the hierarchy
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
    throw new Error('ClassCastException');
  },
};

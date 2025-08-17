module.exports = {
  new: async (frame, instruction, jvm) => {
    const className = instruction.arg;
    await jvm.loadClassByName(className);

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
            await jvm.loadClassByName(superClassName);
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

    if (objRef.lockOwner === null) {
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
        // This should throw IllegalMonitorStateException, but for now we'll log it.
        console.error(`Thread ${thread.id} attempted to exit monitor on object ${objRef.hashCode} not owned by it.`);
        return;
    }

    objRef.lockCount--;
    if (objRef.lockCount === 0) {
      objRef.lockOwner = null;
      const blockedThread = jvm.threads.find(t => t.status === 'BLOCKED' && t.blockingOn === objRef);
      if (blockedThread) {
        blockedThread.status = 'RUNNABLE';
        delete blockedThread.blockingOn;
      }
    }
  },

  getfield: (frame, instruction, jvm) => {
    const [_, className, [fieldName, descriptor]] = instruction.arg;
    const objRef = frame.stack.pop();
    // In a real implementation, we should check for NullPointerException here.
    const value = objRef.fields[`${className}.${fieldName}`];
    frame.stack.push(value);
  },

  putfield: (frame, instruction, jvm) => {
    const [_, className, [fieldName, descriptor]] = instruction.arg;
    const value = frame.stack.pop();
    const objRef = frame.stack.pop();
    // In a real implementation, we should check for NullPointerException here.
    objRef.fields[`${className}.${fieldName}`] = value;
  },

  getstatic: (frame, instruction, jvm) => {
    const [_, className, [fieldName, descriptor]] = instruction.arg;

    const field = jvm._jreFindStaticField(className, fieldName, descriptor);
    if (field) {
      frame.stack.push(field);
    } else {
      console.error(`Unsupported getstatic: ${className}.${fieldName}`);
    }
  },
  arraylength: (frame, instruction, jvm) => {
    const arrayRef = frame.stack.pop();
    if (arrayRef === null) {
      // TODO: Throw NullPointerException
      return;
    }
    const length = arrayRef.length;
    frame.stack.push(length);
  },
  aaload: (frame, instruction, jvm) => {
    const index = frame.stack.pop();
    const arrayRef = frame.stack.pop();
    if (arrayRef === null) {
      // TODO: Throw NullPointerException
      return;
    }
    const value = arrayRef[index];
    frame.stack.push(value);
  },
  aastore: (frame, instruction, jvm) => {
    const value = frame.stack.pop();
    const index = frame.stack.pop();
    const arrayRef = frame.stack.pop();
    if (arrayRef === null) {
      // TODO: Throw NullPointerException
      return;
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

      // TODO: Check interfaces as well

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
        // TODO: Throw ClassCastException
        return;
      }
      currentClassName = classData.ast.classes[0].superClassName;
    }

    // If we get here, the cast is invalid
    // TODO: Throw ClassCastException
  },
};

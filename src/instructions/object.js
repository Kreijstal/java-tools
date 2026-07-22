function runtimeClassName(objRef) {
  if (typeof objRef === 'string' || objRef instanceof String) {
    return 'java/lang/String';
  }
  return objRef && (objRef._className || objRef.type);
}

function resolveInstanceFieldKey(jvm, objRef, className, fieldName) {
  let currentClassName = className;
  while (currentClassName) {
    const fieldKey = `${currentClassName}.${fieldName}`;
    if (Object.prototype.hasOwnProperty.call(objRef.fields, fieldKey)) {
      return fieldKey;
    }

    const classData = jvm.classes[currentClassName];
    currentClassName = classData && classData.ast && classData.ast.classes[0]
      ? classData.ast.classes[0].superClassName
      : null;
  }

  return Object.keys(objRef.fields).find((fieldKey) => fieldKey.endsWith(`.${fieldName}`));
}

const PRIMITIVE_ARRAY_DESC = {
  boolean: '[Z', byte: '[B', char: '[C', short: '[S',
  int: '[I', long: '[J', float: '[F', double: '[D',
};

// Shared allocators for newarray/anewarray — one home for the semantics so
// the interpreter and the wasm allocation imports cannot drift. Negative
// sizes throw the guest NegativeArraySizeException (catchable, like a real
// JVM), never a host error.
function allocPrimitiveArray(jvm, atype, count) {
  const desc = PRIMITIVE_ARRAY_DESC[atype];
  if (!desc) throw new Error(`Unsupported array type: ${atype}`);
  if (count < 0) {
    throw { type: 'java/lang/NegativeArraySizeException', message: String(count) };
  }
  // With the linear heap on, primitive arrays are TypedArray views over wasm
  // memory (zeroed by construction, element coercion matches Java) instead
  // of plain JS arrays.
  let array;
  if (jvm.wasmHeap) {
    array = jvm.wasmHeap.alloc(desc, count);
  } else {
    array = new Array(count).fill(atype === 'long' ? BigInt(0) : 0);
  }
  array.type = desc;
  array.elementType = atype;
  array.hashCode = jvm.nextHashCode++;
  return array;
}

function allocReferenceArray(jvm, elementType, count) {
  if (count < 0) {
    throw { type: 'java/lang/NegativeArraySizeException', message: String(count) };
  }
  const array = new Array(count).fill(null);
  // An array elementType is already a descriptor ('[I' rows of an int[][]);
  // a class elementType needs the L...; wrapping.
  array.type = elementType.startsWith('[') ? `[${elementType}` : `[L${elementType};`;
  array.elementType = elementType;
  array.hashCode = jvm.nextHashCode++;
  return array;
}

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
      _className: className,
      fields,
      hashCode: jvm.nextHashCode++,
      isLocked: false,
      lockOwner: null,
      lockCount: 0,
      waitSet: [],
    };
    
    // Add JavaScript toString method that calls Java toString
    objRef.toString = function() {
      const currentType = runtimeClassName(this);
      try {
        // Try to find toString method in the class hierarchy
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
          return (result && result.value !== undefined) ? result.value : currentType.split('/').pop();
        }
        return currentType.split('/').pop();
      } catch (e) {
        return currentType.split('/').pop();
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
      throw { type: 'java/lang/NullPointerException', message: null };
    }
    const fieldKey = resolveInstanceFieldKey(jvm, objRef, className, fieldName);
    const value = fieldKey ? objRef.fields[fieldKey] : undefined;
    if (typeof process !== 'undefined' && process.env && process.env.JVM_DEBUG_GETFIELD === `${className}.${fieldName}` && Array.isArray(value)) {
      const locals = (frame.locals || []).slice(0, 5).map((l) => (l !== null && typeof l === 'object' ? `<${l.type}${l.__dbgId ? '#' + l.__dbgId : ''}>` : String(l))).join(' ');
      console.error(`[getfield] ${className}.${fieldName} in ${frame.className || '?'}.${frame.method && frame.method.name}@${frame.pc} locals=[${locals}] [len ${value.length}] ${value.slice(0, 48).join(',')}`);
    }
    frame.stack.push(value);
  },

  putfield: (frame, instruction, jvm) => {
    const [_, className, [fieldName, descriptor]] = instruction.arg;
    const value = frame.stack.pop();
    const objRef = frame.stack.pop();
    if (objRef === null) {
      throw { type: 'java/lang/NullPointerException', message: null };
    }
    const fieldKey = resolveInstanceFieldKey(jvm, objRef, className, fieldName) || `${className}.${fieldName}`;
    if (typeof process !== 'undefined' && process.env && process.env.JVM_DEBUG_PUTFIELD &&
        process.env.JVM_DEBUG_PUTFIELD.split(',').includes(className)) {
      if (!objRef.__dbgId) objRef.__dbgId = (module.exports.__dbgNext = (module.exports.__dbgNext || 0) + 1);
      let rendered;
      if (value === null) rendered = 'null';
      else if (Array.isArray(value)) rendered = `[len ${value.length}] ${value.slice(0, 48).map((v) => (typeof v === 'object' && v !== null ? `<${v.type}>` : String(v))).join(',')}`;
      else if (typeof value === 'object') rendered = `<${value.type}>`;
      else rendered = String(value);
      let by = '';
      if (process.env.JVM_DEBUG_PUTFIELD_STACK) {
        const t = jvm.threads && jvm.threads[jvm.currentThreadIndex];
        if (t && t.callStack && t.callStack.items) {
          by = ' by ' + t.callStack.items.slice(-4).reverse()
            .map((f) => `${f.className}.${f.method && f.method.name}${(f.method && f.method.descriptor) || ''}@${f.pc}`).join(' <- ');
        }
      }
      console.error(`[putfield] ${className}#${objRef.__dbgId}.${fieldName}:${descriptor} = ${rendered}${by}`);
    }
    objRef.fields[fieldKey] = value;
  },

  getstatic: async (frame, instruction, jvm, thread) => {
    const [_, className, [fieldName, descriptor]] = instruction.arg;

    const wasFramePushed = await jvm.initializeClassIfNeeded(className, thread);
    if (wasFramePushed) {
      frame.pc--; // Re-run this instruction after <clinit> is done.
      return;
    }

    const fieldKey = `${fieldName}:${descriptor}`;

    // First, try to get the field from the class registry (regular classes),
    // using JVM field resolution through the superclass chain.
    let currentClassName = className;
    while (currentClassName) {
      const currentClassData = jvm.classes[currentClassName];
      if (currentClassData && currentClassData.staticFields && currentClassData.staticFields.has(fieldKey)) {
        frame.stack.push(currentClassData.staticFields.get(fieldKey));
        return;
      }
      if (currentClassData && currentClassData.staticFields && currentClassData.staticFields.has(fieldName)) {
        frame.stack.push(currentClassData.staticFields.get(fieldName));
        return;
      }
      if (currentClassData && currentClassData.staticFields) {
        for (const [key, value] of currentClassData.staticFields.entries()) {
          if (typeof key === 'string' && key.split(':')[0].replace(/'/g, '') === fieldName) {
            frame.stack.push(value);
            return;
          }
        }
      }

      currentClassName = currentClassData && currentClassData.ast && currentClassData.ast.classes[0]
        ? currentClassData.ast.classes[0].superClassName
        : null;
    }

    // If not found in class registry, try the JRE registry (for JRE classes)
    if (jvm.jre && jvm.jre[className] && jvm.jre[className].staticFields) {
      const jreStaticFields = jvm.jre[className].staticFields;
      if (Object.prototype.hasOwnProperty.call(jreStaticFields, fieldKey)) {
        frame.stack.push(jreStaticFields[fieldKey]);
        return;
      }

      // Try alternative field key formats for JRE registry
      const alternativeKeys = [
        `'${fieldName}:${descriptor}'`,
        `${fieldName}:${descriptor}'`,
        `'${fieldName}:${descriptor}`,
        fieldName,
        `'${fieldName}'`
      ];

      for (const altKey of alternativeKeys) {
        if (Object.prototype.hasOwnProperty.call(jreStaticFields, altKey)) {
          frame.stack.push(jreStaticFields[altKey]);
          return;
        }
      }
    }

    // Debug logging for troubleshooting (only in verbose mode)
    if (jvm.verbose) {
      const classData = jvm.classes[className];
      console.log(`Static field lookup failed for ${className}.${fieldName}`);
      console.log(`Looking for field key: "${fieldKey}"`);
      console.log(`Class registry static fields:`, classData && classData.staticFields ? Array.from(classData.staticFields.keys()) : 'none');
      console.log(`JRE registry static fields:`, jvm.jre && jvm.jre[className] && jvm.jre[className].staticFields ? Object.keys(jvm.jre[className].staticFields) : 'none');
    }

    throw new Error(`Unresolved static field: ${className}.${fieldName}`);
  },

  

  putstatic: async (frame, instruction, jvm, thread) => {
    const [_, className, [fieldName, descriptor]] = instruction.arg;

    // Trigger <clinit> BEFORE popping: if a <clinit> frame is pushed we rewind
    // pc and re-run this instruction, so the operand must stay on the stack.
    const wasFramePushed = await jvm.initializeClassIfNeeded(className, thread);
    if (wasFramePushed) {
      frame.pc--; // Re-run this instruction after <clinit> is done.
      return;
    }

    if (frame.stack.isEmpty()) {
      const m = frame.method || {};
      throw new Error(`Stack underflow at putstatic ${className}.${fieldName}:${descriptor} in ${frame.className}.${m.name}${m.descriptor} pc=${frame.pc}`);
    }
    const value = frame.stack.pop();

    const fieldKey = `${fieldName}:${descriptor}`;
    let currentClassName = className;
    while (currentClassName) {
      const currentClassData = jvm.classes[currentClassName];
      if (currentClassData && currentClassData.staticFields && currentClassData.staticFields.has(fieldKey)) {
        currentClassData.staticFields.set(fieldKey, value);
        return;
      }

      currentClassName = currentClassData && currentClassData.ast && currentClassData.ast.classes[0]
        ? currentClassData.ast.classes[0].superClassName
        : null;
    }

    const classData = jvm.classes[className];
    if (classData && classData.staticFields) {
      classData.staticFields.set(fieldKey, value);
      return;
    }

    throw new Error(`Unsupported putstatic: ${className}.${fieldName}`);
  },

  arraylength: (frame, instruction, jvm) => {
    const arrayRef = frame.stack.pop();
    if (arrayRef === null || arrayRef === undefined) {
      throw {
        type: 'java/lang/NullPointerException',
        message: `Attempted to get length of null array in ${frame.method.name}`
      };
    }
    const length = arrayRef.length;
    frame.stack.push(length);
  },
  anewarray: (frame, instruction, jvm) => {
    const count = frame.stack.pop();
    frame.stack.push(allocReferenceArray(jvm, instruction.arg, count));
  },

  instanceof: async (frame, instruction, jvm, thread) => {
    const targetClassName = instruction.arg;
    const objRef = frame.stack.pop();
    if (objRef === null || objRef === undefined) {
      frame.stack.push(0);
      return;
    }
    frame.stack.push(await jvm.isInstanceOfAsync(runtimeClassName(objRef), targetClassName) ? 1 : 0);
  },

  multianewarray: (frame, instruction, jvm) => {
    const [className, dimensions] = instruction.arg;
    const counts = [];
    for (let i = 0; i < dimensions; i++) {
      counts.unshift(frame.stack.pop());
    }

    const baseType = className.replace(/^\[+/, '');
    const leafDefault = (() => {
      if (baseType.startsWith('L')) return null;
      switch (baseType) {
        case 'Z':
        case 'B':
        case 'S':
        case 'I':
        case 'C':
          return 0;
        case 'J':
          return BigInt(0);
        case 'F':
        case 'D':
          return 0.0;
        default:
          return null;
      }
    })();

    const createMultiArray = (dims, depth = 0) => {
      const count = dims[0];
      const remaining = dims.slice(1);
      let arr;
      if (remaining.length === 0) {
        arr = (jvm.wasmHeap && !baseType.startsWith('L') &&
          jvm.wasmHeap.alloc(`[${baseType}`, count)) ||
          new Array(count).fill(leafDefault);
      } else {
        arr = new Array(count).fill(null);
        for (let i = 0; i < count; i++) {
          arr[i] = createMultiArray(remaining, depth + 1);
        }
      }
      // Each nested Java array has its own runtime class. For example, rows of
      // an [[I are [I instances and must pass checkcast [I. Without this tag,
      // runtimeClassName returned undefined for rows produced by
      // multianewarray even though newarray/anewarray were already tagged.
      arr.type = className.slice(depth);
      arr.elementType = arr.type.slice(1);
      arr.hashCode = jvm.nextHashCode++;
      return arr;
    };

    const newArray = createMultiArray(counts);
    frame.stack.push(newArray);
  },

  checkcast: async (frame, instruction, jvm) => {
    const targetClassName = instruction.arg;
    const objRef = frame.stack.peek();

    if (objRef === null) {
      return;
    }

    if (await jvm.isInstanceOfAsync(runtimeClassName(objRef), targetClassName)) {
      return;
    }

    throw {
      type: 'java/lang/ClassCastException',
      message: `${runtimeClassName(objRef)} cannot be cast to ${targetClassName}`,
    };
  },

  newarray: (frame, instruction, jvm) => {
    const count = frame.stack.pop();
    frame.stack.push(allocPrimitiveArray(jvm, instruction.arg, count));
  },
};

module.exports.resolveInstanceFieldKey = resolveInstanceFieldKey;
module.exports.runtimeClassName = runtimeClassName;
module.exports.allocPrimitiveArray = allocPrimitiveArray;
module.exports.allocReferenceArray = allocReferenceArray;

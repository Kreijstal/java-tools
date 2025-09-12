function convertCodeItem(item, invokeDynamicMap) {
  if (!item) return null;

  if (item.instruction && (item.instruction.op === 'ldc' || item.instruction.op === 'ldc_w' || item.instruction.op === 'ldc2_w')) {
    const argStr = item.instruction.arg;
    if (typeof argStr === 'string') {
      // Check for string literals
      if (argStr.startsWith('"') && argStr.endsWith('"')) {
        try {
          item.instruction.arg = JSON.parse(argStr);
        } catch (e) {
          // Leave as string if parsing fails
        }
      } else if (argStr.endsWith('f')) {
        const floatVal = parseFloat(argStr);
        if (!isNaN(floatVal)) {
          item.instruction.arg = {
            value: floatVal,
            type: 'Float'
          };
        }
      } else if (argStr.includes('e') || argStr.includes('E') || argStr.includes('.')) {
        const doubleVal = parseFloat(argStr);
        if (!isNaN(doubleVal)) {
          item.instruction.arg = {
            value: doubleVal,
            type: 'Double'
          };
        }
      } else {
        const numVal = Number(argStr);
        if (Number.isInteger(numVal)) {
          item.instruction.arg = numVal;
        }
      }
    }
  }

  // Handle invokedynamic instructions
  if (item.instruction && item.instruction.op === 'invokedynamic') {
    const argStr = item.instruction.arg;
    if (typeof argStr === 'string' && invokeDynamicMap && invokeDynamicMap[argStr]) {
      const invokeDynamicInfo = invokeDynamicMap[argStr];
      item.instruction.arg = {
        bootstrap_method_attr_index: invokeDynamicInfo.bootstrap_method_attr_index,
        nameAndType: invokeDynamicInfo.nameAndType
      };
    }
  }

  return item;
}

function convertAttribute(attribute, invokeDynamicMap) {
  if (!attribute) return null;

  if (attribute.type === 'code') {
    const code = attribute.code;
    return {
      type: 'code',
      code: {
        long: code.long,
        stackSize: code.stackSize,
        localsSize: code.localsSize,
        codeItems: code.codeItems.map(item => convertCodeItem(item, invokeDynamicMap)).filter(Boolean),
        exceptionTable: [], // Add empty exception table
        attributes: code.attributes.map(attr => convertAttribute(attr, invokeDynamicMap)).filter(Boolean)
      }
    };
  }

  if (attribute.type === 'linenumbertable') {
    return attribute; // Structure is the same
  }

  if (attribute.type === 'attribute' && attribute.attribute.type === 'sourcefile') {
      return attribute;
  }

  return attribute;
}

function convertClsitem(item, invokeDynamicMap) {
  if (!item) return null;

  switch (item.type) {
    case 'method':
      return {
        type: 'method',
        method: {
          flags: item.method.flags,
          name: item.method.name,
          descriptor: item.method.descriptor,
          attributes: item.method.attributes.map(attr => convertAttribute(attr, invokeDynamicMap)).filter(Boolean)
        }
      };
    case 'attribute':
      return convertAttribute(item, invokeDynamicMap);
    default:
      return item;
  }
}

function convertConstToBootstrapMethod(constItem) {
  // Convert InvokeDynamic const to bootstrap method structure
  if (constItem.constValue && constItem.constValue[0] === 'InvokeDynamic') {
    const [, methodHandle, finalMethodRef] = constItem.constValue;
    
    // Extract bootstrap method information and arguments
    const [bootstrapMethodInfo, bootstrapArgs] = methodHandle;
    
    // Extract method handle information
    const [handleKind, methodRef] = bootstrapMethodInfo;
    const [, className, nameAndDescriptor] = methodRef;
    const [methodName, descriptor] = nameAndDescriptor;
    
    // Extract arguments (string literals)
    const arguments = [];
    if (bootstrapArgs && bootstrapArgs.length > 0) {
      // bootstrapArgs[0] contains the array of arguments before the colon separator
      const argArray = bootstrapArgs[0];
      if (Array.isArray(argArray)) {
        for (const arg of argArray) {
          if (Array.isArray(arg) && arg.length === 2 && arg[0] === 'String') {
            // Convert string format: "String" "\"text\"" -> { value: "text", type: "String" }
            let stringValue = arg[1];
            if (stringValue.startsWith('"') && stringValue.endsWith('"')) {
              try {
                stringValue = JSON.parse(stringValue);
              } catch (e) {
                // Handle escape sequences manually if JSON.parse fails
                stringValue = stringValue.slice(1, -1); // Remove quotes
                stringValue = stringValue.replace(/\\u([0-9a-fA-F]{4})/g, (match, hex) => {
                  return String.fromCharCode(parseInt(hex, 16));
                });
              }
            }
            arguments.push({
              value: stringValue,
              type: "String"
            });
          }
        }
      }
    }
    
    return {
      method_ref: {
        value: {
          kind: handleKind,
          reference: {
            className: className,
            nameAndType: {
              name: methodName,
              descriptor: descriptor
            }
          }
        },
        type: "MethodHandle"
      },
      arguments: arguments
    };
  }
  
  return null;
}

function convertKrak2AstToClassAst(krak2Ast) {
  if (!krak2Ast || !krak2Ast.classes) {
    return { classes: [] };
  }

  const convertedClasses = krak2Ast.classes.map(classDef => {
    const bootstrapMethods = [];
    const nonConstItems = [];
    const invokeDynamicRefs = [];
    
    // First pass: collect InvokeDynamic consts in order
    for (const item of classDef.items) {
      if (item.type === 'const' && item.constValue && item.constValue[0] === 'InvokeDynamic') {
        const bootstrapMethod = convertConstToBootstrapMethod(item);
        if (bootstrapMethod) {
          bootstrapMethods.push(bootstrapMethod);
          invokeDynamicRefs.push(item.ref);
        }
      } else if (item.type === 'const' && item.constValue && item.constValue[0] === 'MethodHandle') {
        // Filter out MethodHandle consts that are used by InvokeDynamic
        // These are part of the bootstrap method infrastructure
        continue;
      } else {
        nonConstItems.push(item);
      }
    }
    
    // Reverse the bootstrap methods to match Krakatau's ordering
    if (bootstrapMethods.length > 0) {
      bootstrapMethods.reverse();
      invokeDynamicRefs.reverse();
    }
    
    // Build a map for quick lookups
    const itemsByRef = new Map(classDef.items.map(item => [item.ref, item]));

    // Build the invokeDynamicMap with correct indices after reversal
    const invokeDynamicMap = {};
    for (let i = 0; i < invokeDynamicRefs.length; i++) {
      const item = itemsByRef.get(invokeDynamicRefs[i]);
      if (item) {
        // Extract final method ref from constValue for nameAndType
        const [, , finalMethodRef] = item.constValue;
        const [methodName, descriptor] = finalMethodRef;
        
        invokeDynamicMap[item.ref] = {
          bootstrap_method_attr_index: i,
          nameAndType: {
            name: methodName,
            descriptor: descriptor
          }
        };
      }
    }
    
    const result = {
      version: classDef.version,
      flags: classDef.flags,
      className: classDef.className,
      superClassName: classDef.superClass,
      interfaces: classDef.interfaces,
      items: nonConstItems.map(item => convertClsitem(item, invokeDynamicMap)).filter(Boolean)
    };
    
    // Only add bootstrapMethods if there are any
    if (bootstrapMethods.length > 0) {
      result.bootstrapMethods = bootstrapMethods;
    }
    
    return result;
  });

  return {
    classes: convertedClasses
  };
}

module.exports = { convertKrak2AstToClassAst };

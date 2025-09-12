function convertCodeItem(item) {
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

  return item;
}

function convertAttribute(attribute) {
  if (!attribute) return null;

  if (attribute.type === 'code') {
    const code = attribute.code;
    return {
      type: 'code',
      code: {
        long: code.long,
        stackSize: code.stackSize,
        localsSize: code.localsSize,
        codeItems: code.codeItems.map(convertCodeItem).filter(Boolean),
        exceptionTable: [], // Add empty exception table
        attributes: code.attributes.map(convertAttribute).filter(Boolean)
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

function convertClsitem(item) {
  if (!item) return null;

  switch (item.type) {
    case 'method':
      return {
        type: 'method',
        method: {
          flags: item.method.flags,
          name: item.method.name,
          descriptor: item.method.descriptor,
          attributes: item.method.attributes.map(convertAttribute).filter(Boolean)
        }
      };
    case 'attribute':
      return convertAttribute(item);
    default:
      return item;
  }
}

function convertKrak2AstToClassAst(krak2Ast) {
  if (!krak2Ast || !krak2Ast.classes) {
    return { classes: [] };
  }

  const convertedClasses = krak2Ast.classes.map(classDef => {
    return {
      version: classDef.version,
      flags: classDef.flags,
      className: classDef.className,
      superClassName: classDef.superClass,
      interfaces: classDef.interfaces,
      items: classDef.items.map(convertClsitem).filter(Boolean)
    };
  });

  return {
    classes: convertedClasses
  };
}

module.exports = { convertKrak2AstToClassAst };

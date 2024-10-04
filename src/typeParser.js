function parseDescriptor(descriptor) {
  const types = {
    B: "byte",
    C: "char",
    D: "double",
    F: "float",
    I: "int",
    J: "long",
    S: "short",
    Z: "boolean",
    V: "void"
  };

  function parseType(descriptor, index) {
    let arrayDepth = 0;
    while (descriptor[index] === '[') {
      arrayDepth++;
      index++;
    }

    if (descriptor[index] === 'L') {
      const semicolonIndex = descriptor.indexOf(';', index);
      const className = descriptor.substring(index + 1, semicolonIndex).replace(/\//g, '.');
      index = semicolonIndex + 1;
      return { type: className + '[]'.repeat(arrayDepth), index };
    }

    const type = types[descriptor[index]];
    index++;
    return { type: type + '[]'.repeat(arrayDepth), index };
  }

  function parseMethodDescriptor(descriptor) {
    const params = [];
    let index = 1; // Skip the opening '('

    while (descriptor[index] !== ')') {
      const { type, index: newIndex } = parseType(descriptor, index);
      params.push(type);
      index = newIndex;
    }

    index++; // Skip the closing ')'
    const { type: returnType } = parseType(descriptor, index);

    return { params, returnType };
  }

  const methodDescriptor = parseMethodDescriptor(descriptor);
  const classNames = [];

  // Collect class names from parameter types
  methodDescriptor.params.forEach(param => {
    if (param.includes('/')) {
      classNames.push(param.replace(/\./g, '/'));
    }
  });

  // Collect class name from return type
  if (methodDescriptor.returnType.includes('/')) {
    classNames.push(methodDescriptor.returnType.replace(/\./g, '/'));
  }

  return classNames;
}

function descriptorToString(descriptorAST) {
  const params = descriptorAST.params.join(', ');
  return `${descriptorAST.returnType}(${params})`;
}

module.exports = { parseDescriptor, descriptorToString };

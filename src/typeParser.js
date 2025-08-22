const { primitiveTypeDescriptors } = require("./constants");

function parseDescriptor(descriptor) {
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

    const type = primitiveTypeDescriptors[descriptor[index]];
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

  if (descriptor.startsWith('(')) {
    return parseMethodDescriptor(descriptor);
  } else {
    const { type } = parseType(descriptor, 0);
    return [type];
  }
}

function descriptorToString(descriptorAST) {
  const params = descriptorAST.params.join(', ');
  return `${descriptorAST.returnType}(${params})`;
}

module.exports = { parseDescriptor, descriptorToString };

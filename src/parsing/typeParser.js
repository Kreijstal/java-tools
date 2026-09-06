const { primitiveTypeDescriptors } = require('../core/constants');

function parseDescriptor(descriptor) {
  const types = primitiveTypeDescriptors;
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

  if (descriptor.startsWith('(')) {
    return parseMethodDescriptor(descriptor);
  } else {
    const { type } = parseType(descriptor, 0);
    return [type];
  }
}

// The internal class names a descriptor names, e.g.
// "(Ljava/lang/String;[I)Lfoo/Bar;" -> ["java/lang/String", "foo/Bar"].
//
// parseDescriptor is the wrong tool for this: it returns DISPLAY types
// ("java.lang.String", with "[]" suffixes), so a caller that needs to load the
// class would have to convert back. This keeps the internal form.
//
// Every object type in a descriptor starts with 'L' at a type position and
// ends at the next ';'. No primitive code is 'L', and an 'L' inside a class
// name is skipped over because the scan resumes past the terminator.
function objectTypesInDescriptor(descriptor) {
  const names = [];
  if (typeof descriptor !== 'string') return names;
  for (let index = 0; index < descriptor.length; index += 1) {
    if (descriptor[index] !== 'L') continue;
    const end = descriptor.indexOf(';', index);
    if (end === -1) break;
    names.push(descriptor.slice(index + 1, end));
    index = end;
  }
  return names;
}

function descriptorToString(descriptorAST) {
  const params = descriptorAST.params.join(', ');
  return `${descriptorAST.returnType}(${params})`;
}

module.exports = { parseDescriptor, descriptorToString,
  objectTypesInDescriptor };

const { parseDescriptor } = require('../../../typeParser');

function handleString(methodName, descriptor, frame, args, obj) {
  if (methodName === 'concat') {
    const result = obj + args[0];
    frame.stack.push(result);
  } else if (methodName === 'toUpperCase') {
    const result = obj.toUpperCase();
    frame.stack.push(result);
  } else if (methodName === 'toLowerCase') {
    const result = obj.toLowerCase();
    frame.stack.push(result);
  } else if (methodName === 'length') {
    const result = obj.length;
    frame.stack.push(result);
  } else {
    console.error(`Unsupported String method: ${methodName}`);
    const { returnType } = parseDescriptor(descriptor);
    if (returnType === 'V') {
      // void return type, don't push anything
    } else if (returnType === 'Ljava/lang/String;') {
      frame.stack.push(obj); // return the original string
    } else {
      frame.stack.push(null); // default return value
    }
  }
  return true;
}

module.exports = handleString;

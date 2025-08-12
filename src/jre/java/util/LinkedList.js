function handleLinkedList(methodName, descriptor, frame, args, obj) {
  if (methodName === 'add') {
    obj.elements.push(args[0]);
    frame.stack.push(true); // add always returns true
  } else if (methodName === 'get') {
    const index = args[0];
    const value = obj.elements[index];
    frame.stack.push(value);
  } else if (methodName === 'size') {
    frame.stack.push(obj.elements.length);
  } else {
    console.error(`Unsupported LinkedList method: ${methodName}`);
  }
  return true;
}

module.exports = handleLinkedList;

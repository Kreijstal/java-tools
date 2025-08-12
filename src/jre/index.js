const handleString = require('./java/lang/String');
const handlePrintStream = require('./java/io/PrintStream');
const handleLinkedList = require('./java/util/LinkedList');

function handleJreCall(className, methodName, descriptor, frame, args, obj) {
  switch (className) {
    case 'java/lang/String':
      return handleString(methodName, descriptor, frame, args, obj);
    case 'java/io/PrintStream':
      return handlePrintStream(methodName, descriptor, frame, args, obj);
    case 'java/util/LinkedList':
      return handleLinkedList(methodName, descriptor, frame, args, obj);
    default:
      console.error(`Unsupported invokevirtual: ${className}.${methodName}${descriptor}`);
      return false;
  }
}

module.exports = handleJreCall;

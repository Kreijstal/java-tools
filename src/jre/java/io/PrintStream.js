function handlePrintStream(methodName, descriptor, frame, args, obj) {
  if (methodName === 'println') {
    if (obj && obj['java/io/PrintStream'] && obj['java/io/PrintStream']['println']) {
      obj['java/io/PrintStream']['println'](...args);
    } else {
      console.log(...args);
    }
  } else {
    console.error(`Unsupported PrintStream method: ${methodName}`);
  }
  return true;
}

module.exports = handlePrintStream;

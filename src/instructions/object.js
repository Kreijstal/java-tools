module.exports = {
  new: (frame, instruction) => {
    const className = instruction.arg;
    // In a real JVM, this would be a more complex object representation.
    let objRef;
    if (className === 'java/util/LinkedList') {
      objRef = { type: className, elements: [] };
    } else {
      objRef = { type: className, fields: {} };
    }
    frame.stack.push(objRef);
  },
  getstatic: (frame, instruction, jvm) => {
    const [_, className, [fieldName, descriptor]] = instruction.arg;

    if (jvm.jre[className] && jvm.jre[className][fieldName]) {
      const field = jvm.jre[className][fieldName];
      frame.stack.push(field);
      return;
    }

    if (className === 'java/lang/System' && fieldName === 'out') {
      const printStream = {
        type: 'java/io/PrintStream',
        println: jvm._jreMethods['java/io/PrintStream.println']
      };
      frame.stack.push(printStream);
      return;
    }

    console.error(`Unsupported getstatic: ${className}.${fieldName}`);
  },
};

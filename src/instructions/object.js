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

    if (className === 'java/lang/System' && fieldName === 'in') {
      const inputStream = {
        type: 'java/io/InputStream',
        'java/io/InputStream': {
          read: () => {
            if (jvm.stdin_cursor >= jvm.stdin.length) {
              return -1;
            }
            return jvm.stdin.charCodeAt(jvm.stdin_cursor++);
          }
        }
      };
      frame.stack.push(inputStream);
      return;
    }

    console.error(`Unsupported getstatic: ${className}.${fieldName}`);
  },
  arraylength: (frame) => {
    const arrayRef = frame.stack.pop();
    if (arrayRef === null) {
      // TODO: Throw NullPointerException
      return;
    }
    const length = arrayRef.length;
    frame.stack.push(length);
  },
  aaload: (frame) => {
    const index = frame.stack.pop();
    const arrayRef = frame.stack.pop();
    if (arrayRef === null) {
      // TODO: Throw NullPointerException
      return;
    }
    const value = arrayRef[index];
    frame.stack.push(value);
  },
  aastore: (frame) => {
    const value = frame.stack.pop();
    const index = frame.stack.pop();
    const arrayRef = frame.stack.pop();
    if (arrayRef === null) {
      // TODO: Throw NullPointerException
      return;
    }
    arrayRef[index] = value;
  },
  anewarray: (frame, instruction) => {
    const count = frame.stack.pop();
    const array = new Array(count).fill(null);
    frame.stack.push(array);
  },
};

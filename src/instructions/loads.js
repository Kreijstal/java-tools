module.exports = {
  iload: (frame, instruction) => {
    const index = parseInt(instruction.arg, 10);
    const value = frame.locals[index];
    frame.stack.push(value);
  },
  iload_0: (frame) => {
    frame.stack.push(frame.locals[0]);
  },
  iload_1: (frame) => {
    frame.stack.push(frame.locals[1]);
  },
  iload_2: (frame) => {
    frame.stack.push(frame.locals[2]);
  },
  iload_3: (frame) => {
    frame.stack.push(frame.locals[3]);
  },
  lload: (frame, instruction) => {
    const index = parseInt(instruction.arg, 10);
    const value = frame.locals[index];
    frame.stack.push(value);
  },
  lload_0: (frame) => {
    frame.stack.push(frame.locals[0]);
  },
  lload_1: (frame) => {
    frame.stack.push(frame.locals[1]);
  },
  lload_2: (frame) => {
    frame.stack.push(frame.locals[2]);
  },
  lload_3: (frame) => {
    frame.stack.push(frame.locals[3]);
  },
  fload: (frame, instruction) => {
    const index = parseInt(instruction.arg, 10);
    const value = frame.locals[index];
    frame.stack.push(value);
  },
  fload_0: (frame) => {
    frame.stack.push(frame.locals[0]);
  },
  fload_1: (frame) => {
    frame.stack.push(frame.locals[1]);
  },
  fload_2: (frame) => {
    frame.stack.push(frame.locals[2]);
  },
  fload_3: (frame) => {
    frame.stack.push(frame.locals[3]);
  },
  dload: (frame, instruction) => {
    const index = parseInt(instruction.arg, 10);
    const value = frame.locals[index];
    frame.stack.push(value);
  },
  dload_0: (frame) => {
    frame.stack.push(frame.locals[0]);
  },
  dload_1: (frame) => {
    frame.stack.push(frame.locals[1]);
  },
  dload_2: (frame) => {
    frame.stack.push(frame.locals[2]);
  },
  dload_3: (frame) => {
    frame.stack.push(frame.locals[3]);
  },
  aload: (frame, instruction) => {
    const index = parseInt(instruction.arg, 10);
    const ref = frame.locals[index];
    frame.stack.push(ref);
  },
  aload_0: (frame) => {
    frame.stack.push(frame.locals[0]);
  },
  aload_1: (frame) => {
    frame.stack.push(frame.locals[1]);
  },
  aload_2: (frame) => {
    frame.stack.push(frame.locals[2]);
  },
  aload_3: (frame) => {
    frame.stack.push(frame.locals[3]);
  },
  iaload: (frame) => {
    const index = frame.stack.pop();
    const arrayRef = frame.stack.pop();
    if (arrayRef === null) {
      throw new Error('NullPointerException');
    }
    if (index < 0 || index >= arrayRef.length) {
      throw { type: 'java/lang/ArrayIndexOutOfBoundsException', message: `Index ${index} out of bounds for length ${arrayRef.length}` };
    }
    const value = arrayRef[index];
    frame.stack.push(value);
  },
  laload: (frame) => {
    const index = frame.stack.pop();
    const arrayRef = frame.stack.pop();
    if (arrayRef === null) {
      throw new Error('NullPointerException');
    }
    if (index < 0 || index >= arrayRef.length) {
      throw { type: 'java/lang/ArrayIndexOutOfBoundsException', message: `Index ${index} out of bounds for length ${arrayRef.length}` };
    }
    const value = arrayRef[index];
    frame.stack.push(value);
  },
  faload: (frame) => {
    const index = frame.stack.pop();
    const arrayRef = frame.stack.pop();
    if (arrayRef === null) {
      throw new Error('NullPointerException');
    }
    if (index < 0 || index >= arrayRef.length) {
      throw { type: 'java/lang/ArrayIndexOutOfBoundsException', message: `Index ${index} out of bounds for length ${arrayRef.length}` };
    }
    const value = arrayRef[index];
    frame.stack.push(value);
  },
  daload: (frame) => {
    const index = frame.stack.pop();
    const arrayRef = frame.stack.pop();
    if (arrayRef === null) {
      throw new Error('NullPointerException');
    }
    if (index < 0 || index >= arrayRef.length) {
      throw { type: 'java/lang/ArrayIndexOutOfBoundsException', message: `Index ${index} out of bounds for length ${arrayRef.length}` };
    }
    const value = arrayRef[index];
    frame.stack.push(value);
  },
  baload: (frame) => {
    const index = frame.stack.pop();
    const arrayRef = frame.stack.pop();
    if (arrayRef === null) {
      throw new Error('NullPointerException');
    }
    if (index < 0 || index >= arrayRef.length) {
      throw { type: 'java/lang/ArrayIndexOutOfBoundsException', message: `Index ${index} out of bounds for length ${arrayRef.length}` };
    }
    const value = arrayRef[index];
    frame.stack.push(value);
  },
  caload: (frame) => {
    const index = frame.stack.pop();
    const arrayRef = frame.stack.pop();
    if (arrayRef === null) {
      throw new Error('NullPointerException');
    }
    if (index < 0 || index >= arrayRef.length) {
      throw { type: 'java/lang/ArrayIndexOutOfBoundsException', message: `Index ${index} out of bounds for length ${arrayRef.length}` };
    }
    const value = arrayRef[index];
    frame.stack.push(value);
  },
  saload: (frame) => {
    const index = frame.stack.pop();
    const arrayRef = frame.stack.pop();
    if (arrayRef === null) {
      throw new Error('NullPointerException');
    }
    if (index < 0 || index >= arrayRef.length) {
      throw { type: 'java/lang/ArrayIndexOutOfBoundsException', message: `Index ${index} out of bounds for length ${arrayRef.length}` };
    }
    const value = arrayRef[index];
    frame.stack.push(value);
  },
};

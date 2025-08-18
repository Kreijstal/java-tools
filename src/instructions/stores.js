module.exports = {
  istore: (frame, instruction) => {
    const index = parseInt(instruction.arg, 10);
    const value = frame.stack.pop();
    frame.locals[index] = value;
  },
  istore_0: (frame) => {
    frame.locals[0] = frame.stack.pop();
  },
  istore_1: (frame) => {
    frame.locals[1] = frame.stack.pop();
  },
  istore_2: (frame) => {
    frame.locals[2] = frame.stack.pop();
  },
  istore_3: (frame) => {
    frame.locals[3] = frame.stack.pop();
  },
  astore: (frame, instruction) => {
    const index = parseInt(instruction.arg, 10);
    const ref = frame.stack.pop();
    frame.locals[index] = ref;
  },
  astore_0: (frame) => {
    frame.locals[0] = frame.stack.pop();
  },
  astore_1: (frame) => {
    frame.locals[1] = frame.stack.pop();
  },
  astore_2: (frame) => {
    frame.locals[2] = frame.stack.pop();
  },
  astore_3: (frame) => {
    frame.locals[3] = frame.stack.pop();
  },
  lstore: (frame, instruction) => {
    const index = parseInt(instruction.arg, 10);
    const value = frame.stack.pop();
    frame.locals[index] = value;
  },
  lstore_0: (frame) => {
    frame.locals[0] = frame.stack.pop();
  },
  lstore_1: (frame) => {
    frame.locals[1] = frame.stack.pop();
  },
  lstore_2: (frame) => {
    frame.locals[2] = frame.stack.pop();
  },
  lstore_3: (frame) => {
    frame.locals[3] = frame.stack.pop();
  },
  fstore: (frame, instruction) => {
    const index = parseInt(instruction.arg, 10);
    const value = frame.stack.pop();
    frame.locals[index] = value;
  },
  fstore_0: (frame) => {
    frame.locals[0] = frame.stack.pop();
  },
  fstore_1: (frame) => {
    frame.locals[1] = frame.stack.pop();
  },
  fstore_2: (frame) => {
    frame.locals[2] = frame.stack.pop();
  },
  fstore_3: (frame) => {
    frame.locals[3] = frame.stack.pop();
  },
  dstore: (frame, instruction) => {
    const index = parseInt(instruction.arg, 10);
    const value = frame.stack.pop();
    frame.locals[index] = value;
  },
  dstore_0: (frame) => {
    frame.locals[0] = frame.stack.pop();
  },
  dstore_1: (frame) => {
    frame.locals[1] = frame.stack.pop();
  },
  dstore_2: (frame) => {
    frame.locals[2] = frame.stack.pop();
  },
  dstore_3: (frame) => {
    frame.locals[3] = frame.stack.pop();
  },
  iastore: (frame) => {
    const value = frame.stack.pop();
    const index = frame.stack.pop();
    const arrayRef = frame.stack.pop();
    if (arrayRef === null) {
      throw new Error('NullPointerException');
    }
    arrayRef[index] = value;
  },
  lastore: (frame) => {
    const value = frame.stack.pop();
    const index = frame.stack.pop();
    const arrayRef = frame.stack.pop();
    if (arrayRef === null) {
      throw new Error('NullPointerException');
    }
    arrayRef[index] = value;
  },
  fastore: (frame) => {
    const value = frame.stack.pop();
    const index = frame.stack.pop();
    const arrayRef = frame.stack.pop();
    if (arrayRef === null) {
      throw new Error('NullPointerException');
    }
    arrayRef[index] = value;
  },
  dastore: (frame) => {
    const value = frame.stack.pop();
    const index = frame.stack.pop();
    const arrayRef = frame.stack.pop();
    if (arrayRef === null) {
      throw new Error('NullPointerException');
    }
    arrayRef[index] = value;
  },
  bastore: (frame) => {
    const value = frame.stack.pop();
    const index = frame.stack.pop();
    const arrayRef = frame.stack.pop();
    if (arrayRef === null) {
      throw new Error('NullPointerException');
    }
    arrayRef[index] = value;
  },
  castore: (frame) => {
    const value = frame.stack.pop();
    const index = frame.stack.pop();
    const arrayRef = frame.stack.pop();
    if (arrayRef === null) {
      throw new Error('NullPointerException');
    }
    arrayRef[index] = value;
  },
  sastore: (frame) => {
    const value = frame.stack.pop();
    const index = frame.stack.pop();
    const arrayRef = frame.stack.pop();
    if (arrayRef === null) {
      throw new Error('NullPointerException');
    }
    arrayRef[index] = value;
  },
};

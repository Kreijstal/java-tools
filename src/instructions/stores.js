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
};

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
};

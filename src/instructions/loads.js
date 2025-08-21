const { _aload } = require('./utils');

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
    _aload(frame);
  },
  laload: (frame) => {
    _aload(frame);
  },
  faload: (frame) => {
    _aload(frame);
  },
  daload: (frame) => {
    _aload(frame);
  },
  baload: (frame) => {
    _aload(frame);
  },
  caload: (frame) => {
    _aload(frame);
  },
  saload: (frame) => {
    _aload(frame);
  },
  aaload: (frame) => {
    _aload(frame);
  },
};

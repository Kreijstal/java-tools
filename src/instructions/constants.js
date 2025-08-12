module.exports = {
  ldc: (frame, instruction) => {
    const value = instruction.arg.replace(/"/g, '');
    frame.stack.push(value);
  },
  bipush: (frame, instruction) => {
    const value = parseInt(instruction.arg, 10);
    frame.stack.push(value);
  },
  iconst_m1: (frame) => {
    frame.stack.push(-1);
  },
  iconst_0: (frame) => {
    frame.stack.push(0);
  },
  iconst_1: (frame) => {
    frame.stack.push(1);
  },
  iconst_2: (frame) => {
    frame.stack.push(2);
  },
  iconst_3: (frame) => {
    frame.stack.push(3);
  },
  iconst_4: (frame) => {
    frame.stack.push(4);
  },
  iconst_5: (frame) => {
    frame.stack.push(5);
  },
};

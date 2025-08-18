module.exports = {
  iadd: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(value1 + value2);
  },
  isub: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(value1 - value2);
  },
  imul: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(value1 * value2);
  },
  idiv: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    if (value2 === 0) {
      throw { type: 'java/lang/ArithmeticException', message: '/ by zero' };
    }
    frame.stack.push(Math.floor(value1 / value2));
  },
  irem: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(value1 % value2);
  },
  iinc: (frame, instruction) => {
    const index = parseInt(instruction.varnum, 10);
    const amount = parseInt(instruction.incr, 10);
    frame.locals[index] += amount;
  },
  ishl: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(value1 << value2);
  },
  ishr: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(value1 >> value2);
  },
  iushr: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(value1 >>> value2);
  },
  iand: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(value1 & value2);
  },
  ior: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(value1 | value2);
  },
  ixor: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(value1 ^ value2);
  },
};

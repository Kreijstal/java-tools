module.exports = {
  i2l: (frame) => {
    const value = frame.stack.pop();
    frame.stack.push(BigInt(value));
  },
  i2f: (frame) => {
    // In JavaScript, int and float are both numbers.
    // No conversion is needed.
  },
  i2d: (frame) => {
    // In JavaScript, int, float, and double are all numbers.
    // No conversion is needed.
  },
};

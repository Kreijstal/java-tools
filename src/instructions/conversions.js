const { toInt, toLong, longToFloat } = require('../core/javaNumeric');

module.exports = {
  i2l: (frame) => {
    const value = frame.stack.pop();
    frame.stack.push(BigInt(value));
  },
  i2f: (frame) => {
    // An int beyond 2^24 rounds to the nearest float (123456789 -> 123456792).
    frame.stack.push(Math.fround(frame.stack.pop()));
  },
  i2d: (frame) => {
    // In JavaScript, int, float, and double are all numbers.
    // No conversion is needed.
  },

  l2i: (frame) => {
    const value = frame.stack.pop();
    // Mask to the low 32 bits as a BigInt BEFORE converting to Number.
    // Number(bigint) on a value > 2^53 rounds to the nearest double first,
    // which would silently zero the low bytes (breaks e.g. Whirlpool).
    const big = typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value)));
    frame.stack.push(Number(BigInt.asIntN(32, big)));
  },
  l2f: (frame) => {
    frame.stack.push(longToFloat(frame.stack.pop()));
  },
  l2d: (frame) => {
    const value = frame.stack.pop();
    frame.stack.push(Number(value));
  },

  f2i: (frame) => {
    frame.stack.push(toInt(frame.stack.pop()));
  },
  f2l: (frame) => {
    frame.stack.push(toLong(frame.stack.pop()));
  },
  f2d: (frame) => {
    const value = frame.stack.pop();
    frame.stack.push(value);
  },

  d2i: (frame) => {
    frame.stack.push(toInt(frame.stack.pop()));
  },
  d2l: (frame) => {
    frame.stack.push(toLong(frame.stack.pop()));
  },
  d2f: (frame) => {
    const value = frame.stack.pop();
    // Convert double to float precision
    frame.stack.push(Math.fround(value));
  },

  i2b: (frame) => {
    const value = frame.stack.pop();
    // Convert int to byte (signed 8-bit)
    frame.stack.push((value << 24) >> 24);
  },
  i2c: (frame) => {
    const value = frame.stack.pop();
    // Convert int to char (unsigned 16-bit)
    frame.stack.push(value & 0xFFFF);
  },
  i2s: (frame) => {
    const value = frame.stack.pop();
    // Convert int to short (signed 16-bit)
    frame.stack.push((value << 16) >> 16);
  },
};

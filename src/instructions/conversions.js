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

  l2i: (frame) => {
    const value = frame.stack.pop();
    frame.stack.push(Number(value) | 0);
  },
  l2f: (frame) => {
    const value = frame.stack.pop();
    frame.stack.push(Number(value));
  },
  l2d: (frame) => {
    const value = frame.stack.pop();
    frame.stack.push(Number(value));
  },

  f2i: (frame) => {
    const value = frame.stack.pop();
    // Handle special cases according to JVM specification
    if (isNaN(value)) {
      frame.stack.push(0);
    } else if (value === Infinity) {
      frame.stack.push(0x7FFFFFFF); // Integer.MAX_VALUE
    } else if (value === -Infinity) {
      frame.stack.push(0x80000000); // Integer.MIN_VALUE
    } else {
      frame.stack.push(Math.trunc(value) | 0);
    }
  },
  f2l: (frame) => {
    const value = frame.stack.pop();
    // Handle special cases according to JVM specification
    if (isNaN(value)) {
      frame.stack.push(BigInt(0));
    } else if (value === Infinity) {
      frame.stack.push(BigInt('9223372036854775807')); // Long.MAX_VALUE
    } else if (value === -Infinity) {
      frame.stack.push(BigInt('-9223372036854775808')); // Long.MIN_VALUE
    } else {
      frame.stack.push(BigInt(Math.trunc(value)));
    }
  },
  f2d: (frame) => {
    const value = frame.stack.pop();
    frame.stack.push(value);
  },

  d2i: (frame) => {
    const value = frame.stack.pop();
    // Handle special cases according to JVM specification
    if (isNaN(value)) {
      frame.stack.push(0);
    } else if (value === Infinity) {
      frame.stack.push(0x7FFFFFFF); // Integer.MAX_VALUE
    } else if (value === -Infinity) {
      frame.stack.push(0x80000000); // Integer.MIN_VALUE
    } else {
      frame.stack.push(Math.trunc(value) | 0);
    }
  },
  d2l: (frame) => {
    const value = frame.stack.pop();
    // Handle special cases according to JVM specification
    if (isNaN(value)) {
      frame.stack.push(BigInt(0));
    } else if (value === Infinity) {
      frame.stack.push(BigInt('9223372036854775807')); // Long.MAX_VALUE
    } else if (value === -Infinity) {
      frame.stack.push(BigInt('-9223372036854775808')); // Long.MIN_VALUE
    } else {
      frame.stack.push(BigInt(Math.trunc(value)));
    }
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

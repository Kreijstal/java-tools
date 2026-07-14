// Java long semantics: wrap every result to a signed 64-bit value.
const toLong = (v) => BigInt.asIntN(64, v);

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
  ineg: (frame) => {
    const value = frame.stack.pop();
    frame.stack.push(-value);
  },
  ladd: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(toLong(BigInt(value1) + BigInt(value2)));
  },
  lsub: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(toLong(BigInt(value1) - BigInt(value2)));
  },
  lmul: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(toLong(BigInt(value1) * BigInt(value2)));
  },
  ldiv: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    if (value2 === 0) {
      throw { type: 'java/lang/ArithmeticException', message: '/ by zero' };
    }
    frame.stack.push(toLong(BigInt(value1) / BigInt(value2)));
  },
  lrem: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    if (value2 === 0) {
      throw { type: 'java/lang/ArithmeticException', message: '/ by zero' };
    }
    frame.stack.push(toLong(BigInt(value1) % BigInt(value2)));
  },
  lshl: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    // Shift distance uses only the low 6 bits (JVM spec).
    frame.stack.push(toLong(BigInt(value1) << (BigInt(value2) & 63n)));
  },
  lshr: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(toLong(BigInt(value1) >> (BigInt(value2) & 63n)));
  },
  lushr: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    const shift = BigInt(value2) & 63n;
    const unsigned = BigInt.asUintN(64, BigInt(value1));
    frame.stack.push(toLong(unsigned >> shift));
  },
  land: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(toLong(BigInt(value1) & BigInt(value2)));
  },
  lor: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(toLong(BigInt(value1) | BigInt(value2)));
  },
  lxor: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(toLong(BigInt(value1) ^ BigInt(value2)));
  },
  lneg: (frame) => {
    const value = frame.stack.pop();
    frame.stack.push(toLong(-BigInt(value)));
  },
  fadd: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(Math.fround(value1 + value2));
  },
  fsub: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(Math.fround(value1 - value2));
  },
  fmul: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(Math.fround(value1 * value2));
  },
  fdiv: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(Math.fround(value1 / value2));
  },
  frem: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(Math.fround(value1 % value2));
  },
  fneg: (frame) => {
    const value = frame.stack.pop();
    frame.stack.push(Math.fround(-value));
  },
  dadd: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(value1 + value2);
  },
  dsub: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(value1 - value2);
  },
  dmul: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(value1 * value2);
  },
  ddiv: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(value1 / value2);
  },
  drem: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(value1 % value2);
  },
  dneg: (frame) => {
    const value = frame.stack.pop();
    frame.stack.push(-value);
  },
  // Comparison instructions
  dcmpl: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    if (isNaN(value1) || isNaN(value2)) {
      frame.stack.push(-1); // NaN bias towards -1
    } else if (value1 < value2) {
      frame.stack.push(-1);
    } else if (value1 > value2) {
      frame.stack.push(1);
    } else {
      frame.stack.push(0);
    }
  },
  dcmpg: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    if (isNaN(value1) || isNaN(value2)) {
      frame.stack.push(1); // NaN bias towards 1
    } else if (value1 < value2) {
      frame.stack.push(-1);
    } else if (value1 > value2) {
      frame.stack.push(1);
    } else {
      frame.stack.push(0);
    }
  },
  fcmpl: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    if (isNaN(value1) || isNaN(value2)) {
      frame.stack.push(-1); // NaN bias towards -1
    } else if (value1 < value2) {
      frame.stack.push(-1);
    } else if (value1 > value2) {
      frame.stack.push(1);
    } else {
      frame.stack.push(0);
    }
  },
  fcmpg: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    if (isNaN(value1) || isNaN(value2)) {
      frame.stack.push(1); // NaN bias towards 1
    } else if (value1 < value2) {
      frame.stack.push(-1);
    } else if (value1 > value2) {
      frame.stack.push(1);
    } else {
      frame.stack.push(0);
    }
  },
  lcmp: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    const long1 = BigInt(value1);
    const long2 = BigInt(value2);
    if (long1 < long2) {
      frame.stack.push(-1);
    } else if (long1 > long2) {
      frame.stack.push(1);
    } else {
      frame.stack.push(0);
    }
  },
};

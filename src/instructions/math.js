// Java long semantics: wrap every result to a signed 64-bit value.
const toLong = (v) => BigInt.asIntN(64, v);

module.exports = {
  // Java int arithmetic is signed 32-bit and wraps on overflow. JS `+ - *`
  // produce full-precision doubles (and overflow to >2^53 / Infinity), so
  // every result must be truncated back to int32. `| 0` wraps add/sub/neg;
  // multiply needs Math.imul (a*b can exceed 2^53 and lose bits before |0).
  iadd: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push((value1 + value2) | 0);
  },
  isub: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push((value1 - value2) | 0);
  },
  imul: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(Math.imul(value1, value2));
  },
  idiv: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    if (value2 === 0) {
      throw { type: 'java/lang/ArithmeticException', message: '/ by zero' };
    }
    // Java integer division truncates toward zero (not floor); `| 0` both
    // truncates and wraps MIN_INT / -1 back to MIN_INT.
    frame.stack.push((value1 / value2) | 0);
  },
  irem: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    if (value2 === 0) {
      throw { type: 'java/lang/ArithmeticException', message: '/ by zero' };
    }
    frame.stack.push((value1 % value2) | 0);
  },
  iinc: (frame, instruction) => {
    const index = parseInt(instruction.varnum, 10);
    const amount = parseInt(instruction.incr, 10);
    frame.locals[index] = (frame.locals[index] + amount) | 0;
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
    // JS `>>>` yields an UNSIGNED 32-bit value; Java iushr is signed. `| 0`
    // maps it back to signed int32 (e.g. -1 >>> 0 must stay -1, not 2^32-1),
    // which matters once the result reaches i2l / comparisons / array indices.
    frame.stack.push((value1 >>> value2) | 0);
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
    frame.stack.push((-value) | 0);
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

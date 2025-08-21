// Helper function to extract numeric value from any source
function extractNumericValue(value) {
  if (typeof value === 'object' && value !== null && typeof value.value === 'number') {
    return value.value;
  }
  return value;
}

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
    frame.stack.push(BigInt(value1) + BigInt(value2));
  },
  lsub: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(BigInt(value1) - BigInt(value2));
  },
  lmul: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(BigInt(value1) * BigInt(value2));
  },
  ldiv: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    if (value2 === 0) {
      throw { type: 'java/lang/ArithmeticException', message: '/ by zero' };
    }
    frame.stack.push(BigInt(value1) / BigInt(value2));
  },
  lrem: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    if (value2 === 0) {
      throw { type: 'java/lang/ArithmeticException', message: '/ by zero' };
    }
    frame.stack.push(BigInt(value1) % BigInt(value2));
  },
  lshl: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(BigInt(value1) << BigInt(value2));
  },
  lshr: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(BigInt(value1) >> BigInt(value2));
  },
  lushr: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    const shift = BigInt(value2);
    if (value1 >= 0) {
      frame.stack.push(BigInt(value1) >> shift);
      return;
    }
    // For negative BigInts, we simulate the unsigned shift.
    const sixtyFour = BigInt(64);
    const result = (BigInt(value1) >> shift) + ((BigInt(1) << sixtyFour) >> shift);
    frame.stack.push(result);
  },
  land: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(BigInt(value1) & BigInt(value2));
  },
  lor: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(BigInt(value1) | BigInt(value2));
  },
  lxor: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(BigInt(value1) ^ BigInt(value2));
  },
  lneg: (frame) => {
    const value = frame.stack.pop();
    frame.stack.push(-BigInt(value));
  },
  fadd: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    const result = extractNumericValue(value1) + extractNumericValue(value2);
    frame.stack.push(result);
  },
  fsub: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    const result = extractNumericValue(value1) - extractNumericValue(value2);
    frame.stack.push(result);
  },
  fmul: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    const result = extractNumericValue(value1) * extractNumericValue(value2);
    frame.stack.push(result);
  },
  fdiv: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    const result = extractNumericValue(value1) / extractNumericValue(value2);
    frame.stack.push(result);
  },
  frem: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    const result = extractNumericValue(value1) % extractNumericValue(value2);
    frame.stack.push(result);
  },
  fneg: (frame) => {
    const value = frame.stack.pop();
    const result = -extractNumericValue(value);
    frame.stack.push(result);
  },
  dadd: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    const result = extractNumericValue(value1) + extractNumericValue(value2);
    frame.stack.push(result);
  },
  dsub: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    const result = extractNumericValue(value1) - extractNumericValue(value2);
    frame.stack.push(result);
  },
  dmul: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    const result = extractNumericValue(value1) * extractNumericValue(value2);
    frame.stack.push(result);
  },
  ddiv: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    const result = extractNumericValue(value1) / extractNumericValue(value2);
    frame.stack.push(result);
  },
  drem: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    const result = extractNumericValue(value1) % extractNumericValue(value2);
    frame.stack.push(result);
  },
  dneg: (frame) => {
    const value = frame.stack.pop();
    const result = -extractNumericValue(value);
    frame.stack.push(result);
  },
  // Comparison instructions
  dcmpl: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    const num1 = extractNumericValue(value1);
    const num2 = extractNumericValue(value2);
    if (isNaN(num1) || isNaN(num2)) {
      frame.stack.push(-1); // NaN bias towards -1
    } else if (num1 < num2) {
      frame.stack.push(-1);
    } else if (num1 > num2) {
      frame.stack.push(1);
    } else {
      frame.stack.push(0);
    }
  },
  dcmpg: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    const num1 = extractNumericValue(value1);
    const num2 = extractNumericValue(value2);
    if (isNaN(num1) || isNaN(num2)) {
      frame.stack.push(1); // NaN bias towards 1
    } else if (num1 < num2) {
      frame.stack.push(-1);
    } else if (num1 > num2) {
      frame.stack.push(1);
    } else {
      frame.stack.push(0);
    }
  },
  fcmpl: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    const num1 = extractNumericValue(value1);
    const num2 = extractNumericValue(value2);
    if (isNaN(num1) || isNaN(num2)) {
      frame.stack.push(-1); // NaN bias towards -1
    } else if (num1 < num2) {
      frame.stack.push(-1);
    } else if (num1 > num2) {
      frame.stack.push(1);
    } else {
      frame.stack.push(0);
    }
  },
  fcmpg: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    const num1 = extractNumericValue(value1);
    const num2 = extractNumericValue(value2);
    if (isNaN(num1) || isNaN(num2)) {
      frame.stack.push(1); // NaN bias towards 1
    } else if (num1 < num2) {
      frame.stack.push(-1);
    } else if (num1 > num2) {
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

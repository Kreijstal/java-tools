const { stackWidthsBefore } = require('./stackMetadata');

// Longs and doubles are each stored as one JavaScript value even though JVM
// stack-manipulation bytecodes count them as two slots. Longs are identifiable
// at runtime (BigInt); doubles are plain Numbers, so use the verifier-derived
// widths attached to the current bytecode item.
function widthsBefore(frame) {
  const item = frame && frame.instructions && frame.instructions[frame.pc - 1];
  return item && item[stackWidthsBefore];
}

function isCat2(value, widths, depthFromTop = 0) {
  if (widths) {
    return widths[widths.length - 1 - depthFromTop] === 2;
  }
  return typeof value === 'bigint';
}

module.exports = {
  dup: (frame) => {
    const topValue = frame.stack.peek();
    frame.stack.push(topValue);
  },
  pop: (frame) => {
    frame.stack.pop();
  },
  pop2: (frame) => {
    const widths = widthsBefore(frame);
    const value1 = frame.stack.pop();
    if (isCat2(value1, widths)) return; // one cat2 value == two slots
    frame.stack.pop();
  },
  swap: (frame) => {
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    frame.stack.push(value2);
    frame.stack.push(value1);
  },
  dup_x1: (frame) => {
    const value1 = frame.stack.pop(); // top
    const value2 = frame.stack.pop(); // second
    frame.stack.push(value1);
    frame.stack.push(value2);
    frame.stack.push(value1);
  },
  dup_x2: (frame) => {
    const widths = widthsBefore(frame);
    const value1 = frame.stack.pop(); // top (cat1)
    const value2 = frame.stack.pop();
    if (isCat2(value2, widths, 1)) {
      // Form 2: value2 is cat2
      frame.stack.push(value1);
      frame.stack.push(value2);
      frame.stack.push(value1);
      return;
    }
    const value3 = frame.stack.pop();
    frame.stack.push(value1);
    frame.stack.push(value3);
    frame.stack.push(value2);
    frame.stack.push(value1);
  },
  dup2: (frame) => {
    const widths = widthsBefore(frame);
    const value1 = frame.stack.pop();
    if (isCat2(value1, widths)) {
      // Form 2: duplicate a single cat2 value
      frame.stack.push(value1);
      frame.stack.push(value1);
      return;
    }
    const value2 = frame.stack.pop();
    frame.stack.push(value2);
    frame.stack.push(value1);
    frame.stack.push(value2);
    frame.stack.push(value1);
  },
  dup2_x1: (frame) => {
    const widths = widthsBefore(frame);
    const value1 = frame.stack.pop();
    if (isCat2(value1, widths)) {
      // Form 2: cat2 over cat1
      const value2 = frame.stack.pop();
      frame.stack.push(value1);
      frame.stack.push(value2);
      frame.stack.push(value1);
      return;
    }
    const value2 = frame.stack.pop();
    const value3 = frame.stack.pop();
    frame.stack.push(value2);
    frame.stack.push(value1);
    frame.stack.push(value3);
    frame.stack.push(value2);
    frame.stack.push(value1);
  },
  dup2_x2: (frame) => {
    const widths = widthsBefore(frame);
    const value1 = frame.stack.pop();
    if (isCat2(value1, widths)) {
      const value2 = frame.stack.pop();
      if (isCat2(value2, widths, 1)) {
        // Form 4: cat2 over cat2
        frame.stack.push(value1);
        frame.stack.push(value2);
        frame.stack.push(value1);
        return;
      }
      // Form 2: cat2 over cat1,cat1
      const value3 = frame.stack.pop();
      frame.stack.push(value1);
      frame.stack.push(value3);
      frame.stack.push(value2);
      frame.stack.push(value1);
      return;
    }
    const value2 = frame.stack.pop();
    const value3 = frame.stack.pop();
    if (isCat2(value3, widths, 2)) {
      // Form 3: cat1,cat1 over cat2
      frame.stack.push(value2);
      frame.stack.push(value1);
      frame.stack.push(value3);
      frame.stack.push(value2);
      frame.stack.push(value1);
      return;
    }
    const value4 = frame.stack.pop();
    frame.stack.push(value2);
    frame.stack.push(value1);
    frame.stack.push(value4);
    frame.stack.push(value3);
    frame.stack.push(value2);
    frame.stack.push(value1);
  },
};

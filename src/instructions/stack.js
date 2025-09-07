module.exports = {
  dup: (frame) => {
    const topValue = frame.stack.peek();
    frame.stack.push(topValue);
  },
  pop: (frame) => {
    frame.stack.pop();
  },
  pop2: (frame) => {
    // Handle the case where there's a BigInt on the stack that should count as 2 slots
    if (frame.stack.size() === 1) {
      const topValue = frame.stack.peek();
      if (typeof topValue === 'bigint') {
        // BigInt represents a long value which takes 2 slots in the JVM
        frame.stack.pop(); // Remove the single BigInt that counts as 2 slots
        return;
      }
    }
    
    frame.stack.pop();
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
      const value1 = frame.stack.pop(); // top
      const value2 = frame.stack.pop(); // second
      const value3 = frame.stack.pop(); // third
      frame.stack.push(value1);
      frame.stack.push(value3);
      frame.stack.push(value2);
      frame.stack.push(value1);
    },
    dup2: (frame) => {
      const value1 = frame.stack.pop(); // top
      const value2 = frame.stack.pop(); // second
      frame.stack.push(value2);
      frame.stack.push(value1);
      frame.stack.push(value2);
      frame.stack.push(value1);
    },
    dup2_x1: (frame) => {
      const value1 = frame.stack.pop(); // top
      const value2 = frame.stack.pop(); // second
      const value3 = frame.stack.pop(); // third
      frame.stack.push(value2);
      frame.stack.push(value1);
      frame.stack.push(value3);
      frame.stack.push(value2);
      frame.stack.push(value1);
    },
    dup2_x2: (frame) => {
      const value1 = frame.stack.pop(); // top
      const value2 = frame.stack.pop(); // second
      const value3 = frame.stack.pop(); // third
      const value4 = frame.stack.pop(); // fourth
      frame.stack.push(value2);
      frame.stack.push(value1);
      frame.stack.push(value4);
      frame.stack.push(value3);
      frame.stack.push(value2);
      frame.stack.push(value1);
    },
};

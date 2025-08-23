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
};

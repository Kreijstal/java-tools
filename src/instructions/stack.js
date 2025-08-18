module.exports = {
  dup: (frame) => {
    const topValue = frame.stack.peek();
    frame.stack.push(topValue);
  },
  pop: (frame) => {
    frame.stack.pop();
  },
  pop2: (frame) => {
    frame.stack.pop();
    frame.stack.pop();
  },
};

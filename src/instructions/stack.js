// Longs are stored as a SINGLE BigInt stack slot in this interpreter, while
// the class file's dup2/pop2 family assumes category-2 values occupy two
// slots. Treat a BigInt as a category-2 value so those forms stay coherent.
// (Doubles are plain numbers and indistinguishable from ints; they keep the
// historical slot-wise behavior.)
const isCat2 = (v) => typeof v === 'bigint';

module.exports = {
  dup: (frame) => {
    const topValue = frame.stack.peek();
    frame.stack.push(topValue);
  },
  pop: (frame) => {
    frame.stack.pop();
  },
  pop2: (frame) => {
    const value1 = frame.stack.pop();
    if (isCat2(value1)) return; // one cat2 value == two slots
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
    const value1 = frame.stack.pop(); // top (cat1)
    const value2 = frame.stack.pop();
    if (isCat2(value2)) {
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
    const value1 = frame.stack.pop();
    if (isCat2(value1)) {
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
    const value1 = frame.stack.pop();
    if (isCat2(value1)) {
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
    const value1 = frame.stack.pop();
    if (isCat2(value1)) {
      const value2 = frame.stack.pop();
      if (isCat2(value2)) {
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
    if (isCat2(value3)) {
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

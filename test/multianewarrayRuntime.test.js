const test = require('tape');
const objectInstructions = require('../src/instructions/object');

function stackFrom(values = []) {
  const items = values.slice();
  return {
    items,
    push(value) { items.push(value); },
    pop() { return items.pop(); },
    peek() { return items[items.length - 1]; },
  };
}

test('multianewarray tags every nested Java array class', async (t) => {
  const frame = { stack: stackFrom([2, 3]) };
  const jvm = {
    nextHashCode: 1,
    isInstanceOfAsync: async (className, target) => className === target,
  };

  objectInstructions.multianewarray(frame, { arg: ['[[I', 2] }, jvm);
  const matrix = frame.stack.pop();
  t.equal(matrix.type, '[[I', 'outer array keeps the two-dimensional descriptor');
  t.equal(matrix[0].type, '[I', 'row carries its one-dimensional descriptor');
  t.equal(matrix[1].type, '[I', 'every row is tagged');

  frame.stack.push(matrix[0]);
  await objectInstructions.checkcast(frame, { arg: '[I' }, jvm);
  t.equal(frame.stack.peek(), matrix[0], 'a valid row checkcast succeeds without changing the stack');
  t.end();
});

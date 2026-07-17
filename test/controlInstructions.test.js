const test = require('tape');
const control = require('../src/instructions/control');
const Stack = require('../src/core/stack');

function frameWithLabels() {
  return {
    pc: 0,
    stack: new Stack(),
    instructions: [
      { labelDef: 'Lstart:', instruction: { op: 'iconst_0' } },
      { instruction: { op: 'goto', arg: 'Lend' } },
      { labelDef: 'Lmiddle:', instruction: { op: 'iconst_1' } },
      { labelDef: 'Lend:', instruction: 'return' },
    ],
  };
}

test('interpreter control flow resolves cached label targets', (t) => {
  const frame = frameWithLabels();

  control.goto(frame, { op: 'goto', arg: 'Lend' });
  t.equal(frame.pc, 3, 'goto resolves a label without its trailing colon');

  frame.pc = 0;
  frame.stack.push(7);
  frame.stack.push(7);
  control.if_icmpeq(frame, { op: 'if_icmpeq', arg: 'Lmiddle' });
  t.equal(frame.pc, 2, 'a taken comparison uses the same cached label map');

  frame.pc = 1;
  frame.stack.push(5);
  frame.stack.push(7);
  control.if_icmpeq(frame, { op: 'if_icmpeq', arg: 'Lend' });
  t.equal(frame.pc, 1, 'a non-taken comparison leaves the program counter unchanged');

  t.throws(() => control.goto(frame, { op: 'goto', arg: 'Lmissing' }),
    /Label Lmissing not found/, 'missing labels remain a loud interpreter error');
  t.end();
});

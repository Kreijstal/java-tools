const test = require('tape');
const DebugController = require('../src/debugController');

test('Debugger rewind', async t => {
  t.plan(4);

  const controller = new DebugController({ rewindHistorySize: 10, classpath: 'sources' });
  await controller.start('sources/SimpleArithmetic.class');

  // Step a few instructions
  await controller.stepInstruction();
  const state1 = controller.getCurrentState();
  await controller.stepInstruction();
  const state2 = controller.getCurrentState();
  await controller.stepInstruction();
  const state3 = controller.getCurrentState();

  // Rewind one step
  await controller.rewind();
  const stateAfterRewind = controller.getCurrentState();

  t.equal(stateAfterRewind.pc, state2.pc, 'PC should be rewound to the previous state');

  // Step forward again
  await controller.stepInstruction();
  const stateAfterStep = controller.getCurrentState();
  t.equal(stateAfterStep.pc, state3.pc, 'PC should be the same as the state before rewind');

  // Test rewinding more steps
  await controller.rewind(2);
  const stateAfterRewind2 = controller.getCurrentState();
  t.equal(stateAfterRewind2.pc, state1.pc, 'PC should be rewound two steps');

  // Test rewinding too far
  try {
    await controller.rewind(100);
  } catch (e) {
    t.equal(e.message, 'Cannot rewind: not enough history', 'Should throw error when rewinding too far');
  }
});

const test = require('tape');
const DebugController = require('../src/debugController');

test('Thread debugging with serialization', async t => {
  t.plan(1);

  let controller = new DebugController({ classpath: ['sources'] });
  await controller.start('ProducerConsumer');

  for (let i = 0; i < 1000; i++) {
    if (controller.isCompleted()) {
      break;
    }
    await controller.stepInstruction();
    const state = controller.serialize();
    const newController = new DebugController({ classpath: ['sources'] });
    await newController.deserialize(state);
    controller = newController;
  }

  if (!controller.isCompleted()) {
    await controller.continue();
  }

  t.ok(controller.isCompleted(), "Execution should complete");
});

const test = require('tape');
const path = require('path');
const DebugController = require('../src/debugController');

test('Thread-Aware Debugger - jvmStep', async (t) => {
  t.plan(6);

  const controller = new DebugController({ classpath: ['sources'] });
  await controller.start('Main');

  t.equal(controller.executionState, 'paused', 'Debugger should start in a paused state');

  let threads = controller.getThreads();
  t.equal(threads.length, 1, 'Should start with one (main) thread');
  t.equal(threads[0].id, 0, 'Main thread should have id 0');

  // Step until we have two threads.
  for (let i = 0; i < 20; i++) {
    await controller.jvmStep();
    threads = controller.getThreads();
    if (threads.length === 2) {
      break;
    }
  }

  threads = controller.getThreads();
  t.equal(threads.length, 2, 'Should have two threads after Thread.start()');

  // Check the state of the new thread
  const newThread = threads.find(thread => thread.id === 1);
  t.ok(newThread, 'New thread should be found');
  t.equal(newThread.status, 'runnable', 'New thread should be runnable');
});

test('Thread-Aware Debugger - threadStep', async (t) => {
    t.plan(3);

    const controller = new DebugController({ classpath: ['sources'] });
    await controller.start('Main');

    // Step until after the new thread is created
    for (let i = 0; i < 20; i++) {
        await controller.jvmStep();
        if (controller.getThreads().length === 2) {
            break;
        }
    }

    // Select the new thread (thread 1)
    controller.selectThread(1);

    // Step until the selected thread is the current one
    let state = controller.getCurrentState();
    while(state.currentThreadId !== 1) {
        await controller.jvmStep();
        state = controller.getCurrentState();
        if (state.executionState === 'stopped') {
            t.fail('Execution stopped before reaching target thread');
            return;
        }
    }
    t.equal(state.currentThreadId, 1, 'Should have switched to thread 1');

    // Perform a threadStep. This should execute instructions and stop when thread 1 is current again.
    const stepResult = await controller.threadStep();
    const finalState = controller.getCurrentState();

    t.equal(stepResult.status, 'paused', 'Debugger should be paused after threadStep');
    t.equal(finalState.currentThreadId, 1, 'Current thread should still be thread 1 after threadStep');
});

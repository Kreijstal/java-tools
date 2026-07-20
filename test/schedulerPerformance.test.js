'use strict';

const test = require('tape');
const { JVM } = require('../src/core/jvm');
const instructions = require('../src/instructions');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');

test('idle scheduler waits instead of spinning zero-delay tasks', (t) => {
  const jvm = new JVM({ eventLoopYieldMs: 16 });
  jvm.threads = [
    { status: 'WAITING' },
    { status: 'SLEEPING', sleepUntil: 1010 },
  ];

  t.equal(jvm._idleWaitDelay(1000), 10,
    'the scheduler waits until the nearest guest deadline');
  jvm.threads[1].sleepUntil = 1100;
  t.equal(jvm._idleWaitDelay(1000), 16,
    'long waits remain bounded so external wakeups stay responsive');
  jvm.threads = [{ status: 'WAITING' }];
  t.equal(jvm._idleWaitDelay(1000), 16,
    'untimed waits use the event-loop responsiveness budget');
  t.end();
});

test('deterministic scheduler never waits on wall time', (t) => {
  const jvm = new JVM({ fakeTime: 1000, eventLoopYieldMs: 16 });
  jvm.threads = [{ status: 'SLEEPING', sleepUntil: 2000 }];
  t.equal(jvm._idleWaitDelay(1010), 0);
  t.end();
});

test('synchronous bytecode handlers are prepared once per shared code body', (t) => {
  const codeItems = [
    { instruction: { op: 'iinc', varnum: '0', incr: '1' } },
    { instruction: { op: 'invokevirtual', arg: [] } },
    { instruction: { op: 'wide', arg: 'iinc 2 3' } },
  ];

  instructions.prepareSyncInstructions(codeItems);
  const firstHandler = codeItems[0][instructions.syncHandler];
  t.equal(typeof firstHandler, 'function', 'sync opcode resolves to its handler');
  t.equal(codeItems[1][instructions.syncHandler], null,
    'async opcode stays on the async dispatcher');
  t.deepEqual(codeItems[2][instructions.syncInstruction],
    { op: 'iinc', varnum: '2', incr: '3' }, 'wide opcode is expanded once');
  instructions.prepareSyncInstructions(codeItems);
  t.equal(codeItems[0][instructions.syncHandler], firstHandler,
    'preparing the same shared method body is idempotent');
  t.deepEqual(Object.keys(codeItems[0]), ['instruction'],
    'prepared dispatch metadata is not serialized or shown by debuggers');
  t.end();
});

test('warm async-capable handlers remain inside an interpreter quantum', async (t) => {
  const method = {
    name: 'warmStatics',
    descriptor: '()V',
    attributes: [{
      type: 'code',
      code: {
        localsSize: '0',
        exceptionTable: [],
        codeItems: [
          { instruction: { op: 'getstatic', arg: [null, 'Test', ['value', 'I']] } },
          { instruction: 'pop' },
          { instruction: 'return' },
        ],
      },
    }],
  };
  const jvm = new JVM({ interpreterBurst: 16, jit: { enabled: false } });
  jvm.classes.Test = {
    ast: { classes: [{ superClassName: null }] },
    staticFields: new Map([['value:I', 7]]),
  };
  jvm.classInitializationState.set('Test', 'INITIALIZED');
  const thread = { id: 0, status: 'runnable', callStack: new Stack() };
  thread.callStack.push(new Frame(method));
  jvm.threads = [thread];

  const result = await jvm.executeTick({ allowBurst: true });
  t.equal(result.bytecodes, 3,
    'getstatic, pop, and return execute in one bounded scheduler tick');
  t.equal(thread.callStack.size(), 0, 'the method completes in that quantum');
  t.end();
});

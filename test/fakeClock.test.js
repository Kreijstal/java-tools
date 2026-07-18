'use strict';

const test = require('tape');
const { JVM } = require('../src/core/jvm');
const Stack = require('../src/core/stack');
const Thread = require('../src/jre/java/lang/Thread');

test('deterministic clocks are isolated per JVM instance', (t) => {
  const first = new JVM({ fakeTime: 1000, fakeTimeStep: 2 });
  const second = new JVM({ fakeTime: 1000, fakeTimeStep: 2 });

  t.equal(first.clock.millis(), 1002);
  t.equal(first.clock.millis(), 1004);
  t.equal(second.clock.millis(), 1002, 'the second JVM has independent time state');
  t.equal(first.clock.random(), second.clock.random(),
    'the first random query is reproducible per JVM');
  t.end();
});

test('scheduler sleep deadlines use the JVM deterministic clock', async (t) => {
  const jvm = new JVM({ fakeTime: 1000, fakeTimeStep: 10, jit: { enabled: false } });
  const thread = {
    id: 0,
    status: 'runnable',
    callStack: new Stack(),
  };
  jvm.threads = [thread];

  Thread.methods['sleep(J)V'](jvm, null, [20n], thread);
  t.equal(thread.sleepUntil, 1030, 'sleep is scheduled in guest-clock time');
  await jvm.executeTick();
  t.equal(thread.status, 'SLEEPING');
  await jvm.executeTick();
  t.equal(thread.status, 'terminated', 'scheduler advances and wakes on the same clock');
  t.end();
});

test('portable save states restore deterministic clock state', async (t) => {
  const original = new JVM({ fakeTime: 1000, fakeTimeStep: 3, jit: { enabled: false } });
  original.clock.millis();
  original.clock.random();
  const state = original.saveState();

  const restored = new JVM({ fakeTime: 9000, fakeTimeStep: 9, jit: { enabled: false } });
  await restored.loadState(state);
  t.equal(restored.clock.step, 3);
  t.equal(restored.clock.seedCounter, original.clock.seedCounter);
  t.equal(restored.clock.random(), original.clock.random(),
    'restored entropy stream resumes from the checkpoint');
  t.end();
});

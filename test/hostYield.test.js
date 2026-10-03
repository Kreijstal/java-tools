'use strict';
const test = require('tape');
const fs = require('node:fs');
const vm = require('node:vm');

// Each host gets its own module and channel queue, as separate browser/Node
// globals do. No live MessagePorts or modified process globals escape a test.
function host({browser = false, channel = true, immediate = true} = {}) {
  const tasks = [], used = [], channels = [];
  const context = {
    module: {exports: {}},
    setTimeout(callback, delay) { used.push(`timer:${delay}`); tasks.push(callback); },
  };
  if (browser) Object.assign(context, {document: {}, requestAnimationFrame() {}});
  if (immediate) context.setImmediate = callback => { used.push('immediate'); tasks.push(callback); };
  if (channel) context.MessageChannel = class {
    constructor() {
      this.port1 = {};
      this.port2 = {postMessage: value => {
        used.push(`channel:${value}`);
        tasks.push(() => this.port1.onmessage({data: value}));
      }};
      channels.push(this);
    }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/core/hostYield'), 'utf8'), context);
  return {...context.module.exports, used, channels, tasks};
}

test('browser channel yields bypass a global immediate polyfill and preserve FIFO completion', async t => {
  const h = host({browser: true});
  const completed = [];
  const first = h.yieldToEventLoop().then(() => completed.push(1));
  const second = h.yieldToEventLoop(0, 'message-channel').then(() => completed.push(2));
  t.deepEqual(h.used, ['channel:0', 'channel:0'], 'both yields use the selected private queue');
  t.equal(h.channels.length, 1, 'concurrent yields share one channel');
  t.deepEqual(completed, [], 'neither yield resolves synchronously');
  h.tasks.shift()();
  await first;
  t.deepEqual(completed, [1], 'first message completes only its own waiter');
  h.tasks.shift()();
  await second;
  t.deepEqual(completed, [1, 2], 'second message completes the next waiter');
  h.channels[0].port1.onmessage({data: 0});
  t.deepEqual(completed, [1, 2], 'a surplus message cannot replay a completed waiter');
  const third = h.yieldToEventLoop();
  h.tasks.shift()(); await third;
  t.equal(h.channels.length, 1, 'later yields reuse the same channel');
  t.end();
});

test('explicit browser timers and positive delays remain timer tasks', async t => {
  const h = host({browser: true});
  const zero = h.yieldToEventLoop(0, 'timer');
  const delayed = h.yieldToEventLoop(9, 'message-channel');
  t.deepEqual(h.used, ['timer:0', 'timer:9']);
  t.equal(h.channels.length, 0, 'timer-only use creates no message ports');
  while (h.tasks.length) h.tasks.shift()();
  await Promise.all([zero, delayed]);
  t.end();
});

test('non-rendering Node host keeps native immediate resumption', async t => {
  const h = host();
  const pending = h.yieldToEventLoop();
  t.deepEqual(h.used, ['immediate']);
  t.equal(h.channels.length, 0, 'Node does not acquire message ports that keep it alive');
  h.tasks.shift()(); await pending;
  t.end();
});

test('hosts lacking MessageChannel retain their available task fallback', async t => {
  for (const immediate of [true, false]) {
    const h = host({browser: true, channel: false, immediate});
    const pending = h.yieldToEventLoop();
    t.deepEqual(h.used, [immediate ? 'immediate' : 'timer:0']);
    h.tasks.shift()(); await pending;
  }
  t.end();
});

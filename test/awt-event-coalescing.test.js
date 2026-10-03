'use strict';

// Motion-event coalescing in the AWT event queue.
//
// The queue holds one record per (listener, component) pair, so "coalesce with
// the tail" only ever worked when a single stream was active. These checks pin
// the per-stream semantics: latest coordinates per listener, no merging across
// listeners or components, and no motion event overtaking a press/release or a
// move/drag switch on its own stream.

const test = require('tape');
const { JVM } = require('../src/core/jvm');
const {
  attachBrowserInput, registerInputComponent,
} = require('../src/platform/browser-awt-input');

function harness() {
  const handlers = new Map();
  const canvas = {
    width: 800,
    height: 600,
    style: {},
    addEventListener(name, fn) { handlers.set(name, fn); },
    focus() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  };
  const jvm = Object.create(JVM.prototype);
  // The pump is exercised separately; these checks are about queue semantics,
  // so keep the timer out of them.
  jvm._scheduleAwtEventPump = () => {};
  attachBrowserInput(jvm, canvas);
  const fire = (name, props) => handlers.get(name)(Object.assign({
    clientX: 0, clientY: 0, buttons: 0, button: 0, detail: 1,
    preventDefault() {},
  }, props));
  const component = kinds => {
    const owner = { _visible: true, _listeners: {} };
    for (const kind of Object.keys(kinds)) {
      owner._listeners[kind] = kinds[kind];
      registerInputComponent(jvm, owner, kind);
    }
    return owner;
  };
  const queue = () => jvm._awtEventQueue || [];
  return { jvm, fire, component, queue };
}

const summarize = queue => queue.map(record =>
  record.listener.type + '.' + record.methodName + '@' + record.event.x);

test('AWT coalescing - two motion listeners each keep their latest position', t => {
  const h = harness();
  const first = { type: 'L1' };
  const second = { type: 'L2' };
  h.component({ mouseMotion: [first, second] });

  for (const x of [10, 20, 30]) h.fire('mousemove', { clientX: x });

  t.equal(h.queue().length, 2,
    'three moves across two listeners collapse to one record each');
  t.deepEqual(summarize(h.queue()), ['L1.mouseMoved@30', 'L2.mouseMoved@30'],
    'both listeners hold the newest coordinates');
  t.end();
});

test('AWT coalescing - one listener on two components keeps both streams', t => {
  const h = harness();
  const shared = { type: 'Shared' };
  const left = h.component({ mouseMotion: [shared] });
  const right = h.component({ mouseMotion: [shared] });

  h.fire('mousemove', { clientX: 11 });
  t.equal(h.queue().length, 2,
    'one physical move over two components queues one record per component');

  h.fire('mousemove', { clientX: 22 });
  t.equal(h.queue().length, 2, 'the second move coalesces per component');
  t.deepEqual(h.queue().map(record => record.event.source), [left, right],
    'the two records keep their own source components');
  t.deepEqual(h.queue().map(record => record.event.x), [22, 22],
    'neither component lost its event to the other');
  t.end();
});

test('AWT coalescing - a move never overtakes a press on its own stream', t => {
  const h = harness();
  const both = { type: 'Both' };
  h.component({ mouse: [both], mouseMotion: [both], key: [both] });

  h.fire('mousemove', { clientX: 5 });
  h.fire('mousedown', { clientX: 6 });
  h.fire('mousemove', { clientX: 7, buttons: 1 });
  h.fire('mouseup', { clientX: 8 });
  h.fire('mousemove', { clientX: 9 });

  t.deepEqual(summarize(h.queue()), [
    'Both.mouseMoved@5',
    'Both.mousePressed@6',
    'Both.mouseDragged@7',
    'Both.mouseReleased@8',
    'Both.mouseMoved@9',
  ], 'press/release order is preserved and the earlier move keeps its position');
  t.end();
});

test('AWT coalescing - move and drag are separate streams', t => {
  const h = harness();
  const motion = { type: 'Motion' };
  h.component({ mouseMotion: [motion] });

  h.fire('mousemove', { clientX: 1 });
  h.fire('mousemove', { clientX: 2, buttons: 1 });
  h.fire('mousemove', { clientX: 3, buttons: 1 });

  t.deepEqual(summarize(h.queue()),
    ['Motion.mouseMoved@1', 'Motion.mouseDragged@3'],
    'a button-state change is a boundary; drags coalesce among themselves');
  t.end();
});

test('AWT coalescing - single listener behaviour is unchanged', t => {
  const h = harness();
  const only = { type: 'Only' };
  h.component({ mouseMotion: [only] });

  for (let x = 0; x < 50; x += 1) h.fire('mousemove', { clientX: x });

  t.equal(h.queue().length, 1, 'the single-listener case still collapses to one');
  t.equal(h.queue()[0].event.x, 49, 'and carries the newest coordinates');
  t.end();
});

test('AWT coalescing - sustained input stops the queue growing per listener', t => {
  const h = harness();
  const listeners = [{ type: 'A' }, { type: 'B' }, { type: 'C' }];
  h.component({ mouseMotion: listeners });

  for (let x = 0; x < 500; x += 1) h.fire('mousemove', { clientX: x % 400 });

  t.equal(h.queue().length, listeners.length,
    '500 moves across three listeners stay at one queued record each');
  t.equal(h.jvm._awtCoalescedEventCount, 500 * 3 - 3,
    'every move after the first on each stream is reported as coalesced');
  t.end();
});

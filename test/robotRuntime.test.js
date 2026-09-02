'use strict';

const test = require('tape');
const {JSDOM} = require('jsdom');
const Robot = require('../src/jre/java/awt/Robot');
const Component = require('../src/jre/java/awt/Component');

function withBrowser(run) {
  const previous = {
    document: global.document, window: global.window,
    MouseEvent: global.MouseEvent, KeyboardEvent: global.KeyboardEvent,
    WheelEvent: global.WheelEvent,
  };
  const dom = new JSDOM('<canvas width="640" height="480" tabindex="0"></canvas>');
  global.window = dom.window;
  global.document = dom.window.document;
  global.MouseEvent = dom.window.MouseEvent;
  global.KeyboardEvent = dom.window.KeyboardEvent;
  global.WheelEvent = dom.window.WheelEvent;
  const canvas = document.querySelector('canvas');
  canvas.getBoundingClientRect = () =>
    ({left: 10, top: 20, width: 640, height: 480, right: 650, bottom: 500});
  document.elementFromPoint = () => canvas;
  return Promise.resolve(run(canvas)).finally(() => {
    Object.assign(global, previous);
    dom.window.close();
  });
}

test('browser Robot dispatches DOM mouse movement and clicks', async (t) => {
  await withBrowser(async (canvas) => {
    const events = [];
    for (const name of ['mousemove', 'mousedown', 'mouseup', 'click', 'wheel']) {
      canvas.addEventListener(name, event => events.push({
        name, x: event.clientX, y: event.clientY,
        button: event.button, buttons: event.buttons,
      }));
    }
    const robot = {};
    Robot.methods['<init>()V']({}, robot, []);
    await Robot.methods['mouseMove(II)V']({}, robot, [320, 198]);
    await Robot.methods['mousePress(I)V']({}, robot, [1024]);
    await Robot.methods['mouseRelease(I)V']({}, robot, [1024]);
    await Robot.methods['mouseWheel(I)V']({}, robot, [3]);
    t.deepEqual(events.map(event => event.name),
      ['mousemove', 'mousedown', 'mouseup', 'click', 'wheel']);
    t.equal(events[0].x, 320);
    t.equal(events[0].y, 198);
    t.equal(events[1].buttons, 1);
    t.equal(events[2].buttons, 0);
  });
  t.end();
});

test('Component screen location round-trips into browser Robot coordinates', async (t) => {
  await withBrowser(async (canvas) => {
    const location = Component.methods['getLocationOnScreen()Ljava/awt/Point;'](
      {}, {_canvasElement: canvas});
    t.deepEqual([location.x, location.y], [10, 20]);
    const events = [];
    canvas.addEventListener('mousemove', event =>
      events.push([event.clientX, event.clientY]));
    const robot = {};
    Robot.methods['<init>()V']({}, robot, []);
    await Robot.methods['mouseMove(II)V']({}, robot,
      [location.x + 320, location.y + 198]);
    t.deepEqual(events, [[330, 218]]);
  });
  t.end();
});

test('browser Robot dispatches keyboard events and retains delay settings', async (t) => {
  await withBrowser(async (canvas) => {
    const events = [];
    canvas._jvmAwtInputAttached = true;
    canvas.focus();
    canvas.addEventListener('keydown', event => events.push([event.type, event.keyCode]));
    canvas.addEventListener('keyup', event => events.push([event.type, event.keyCode]));
    const robot = {};
    Robot.methods['<init>()V']({}, robot, []);
    Robot.methods['setAutoDelay(I)V']({}, robot, [1]);
    await Robot.methods['keyPress(I)V']({}, robot, [37]);
    await Robot.methods['keyRelease(I)V']({}, robot, [37]);
    t.deepEqual(events, [['keydown', 37], ['keyup', 37]]);
    t.equal(Robot.methods['getAutoDelay()I']({}, robot), 1);
  });
  t.end();
});

test('Node Robot constructs headlessly and simulates input as a no-op', async (t) => {
  const previousDocument = global.document;
  const previousMouseEvent = global.MouseEvent;
  delete global.document;
  delete global.MouseEvent;
  const robot = {};
  t.doesNotThrow(() => Robot.methods['<init>()V']({}, robot, []),
    'applets construct a Robot at startup on every host');
  await Robot.methods['mouseMove(II)V']({}, robot, [12, 34]);
  await Robot.methods['mousePress(I)V']({}, robot, [16]);
  await Robot.methods['mouseRelease(I)V']({}, robot, [16]);
  await Robot.methods['keyPress(I)V']({}, robot, [65]);
  await Robot.methods['keyRelease(I)V']({}, robot, [65]);
  await Robot.methods['waitForIdle()V']({}, robot, []);
  t.deepEqual([robot._robotState.x, robot._robotState.y], [12, 34],
    'headless input simulation records state and dispatches nothing');
  global.document = previousDocument;
  global.MouseEvent = previousMouseEvent;
  t.end();
});

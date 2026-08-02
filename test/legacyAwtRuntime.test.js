'use strict';

const test = require('tape');
const Stack = require('../src/core/stack');
const Applet = require('../src/jre/java/applet/Applet');
const CardLayout = require('../src/jre/java/awt/CardLayout');
const Color = require('../src/jre/java/awt/Color');
const Component = require('../src/jre/java/awt/Component');
const Container = require('../src/jre/java/awt/Container');
const Event = require('../src/jre/java/awt/Event');
const GridLayout = require('../src/jre/java/awt/GridLayout');
const TextArea = require('../src/jre/java/awt/TextArea');
const TextField = require('../src/jre/java/awt/TextField');
const StringClass = require('../src/jre/java/lang/String');
const awt = require('../src/platform/awt');
const legacyEvents = require('../src/jre/java/awt/legacyEvents');

function element(tagName = 'div') {
  return {
    tagName,
    style: {},
    children: [],
    appendChild(child) {
      if (!this.children.includes(child)) this.children.push(child);
      child.parentNode = this;
      return child;
    },
    contains(child) {
      return this.children.includes(child);
    },
    querySelector(selector) {
      if (selector === '.awt-applet-root') {
        return this.children.find((child) =>
          child.className === 'awt-applet-root') || null;
      }
      if (selector === 'canvas') {
        return this.children.find((child) => child.tagName === 'canvas') || null;
      }
      return null;
    },
    addEventListener() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: this.width || 1, height: this.height || 1 };
    },
    focus() {},
  };
}

test('legacy Event constants and constructors match java.awt.Event', (t) => {
  t.equal(Event.staticFields['ACTION_EVENT:I'], 1001);
  t.equal(Event.staticFields['KEY_PRESS:I'], 401);
  t.equal(Event.staticFields['SCROLL_LINE_UP:I'], 601);
  t.equal(Event.staticFields['SCROLL_ABSOLUTE:I'], 605);
  t.equal(Event.staticFields['SCROLL_END:I'], 607);

  const target = { type: 'Target' };
  const arg = { type: 'Argument' };
  const shortEvent = {};
  Event.methods['<init>(Ljava/lang/Object;ILjava/lang/Object;)V'](
    {}, shortEvent, [target, 1001, arg]);
  t.equal(shortEvent.target, target);
  t.equal(shortEvent.id, 1001);
  t.equal(shortEvent.arg, arg);

  const fullEvent = {};
  Event.methods['<init>(Ljava/lang/Object;JIIIIILjava/lang/Object;)V'](
    {}, fullEvent, [target, 123n, 501, 7, 9, 65, 3, arg]);
  t.equal(fullEvent.fields['java/awt/Event.when'], 123n);
  t.equal(fullEvent.fields['java/awt/Event.x'], 7);
  t.equal(fullEvent.fields['java/awt/Event.y'], 9);
  t.equal(fullEvent.fields['java/awt/Event.key'], 65);
  t.equal(fullEvent.fields['java/awt/Event.modifiers'], 3);
  t.equal(fullEvent.fields['java/awt/Event.arg'], arg);
  t.end();
});

test('Component legacy dispatch awaits resolved boolean results', async (t) => {
  const originalDispatch = legacyEvents.dispatchDefaultEvent;
  const originalPost = legacyEvents.postEvent;
  try {
    legacyEvents.dispatchDefaultEvent = async () => false;
    legacyEvents.postEvent = async () => false;
    t.equal(await Component.methods['handleEvent(Ljava/awt/Event;)Z'](
      {}, {}, [{ id: 1001 }]), 0);
    t.equal(await Component.methods['postEvent(Ljava/awt/Event;)Z'](
      {}, {}, [{}]), 0);
    legacyEvents.dispatchDefaultEvent = async () => true;
    legacyEvents.postEvent = async () => true;
    t.equal(await Component.methods['handleEvent(Ljava/awt/Event;)Z'](
      {}, {}, [{ id: 1001 }]), 1);
    t.equal(await Component.methods['postEvent(Ljava/awt/Event;)Z'](
      {}, {}, [{}]), 1);
  } finally {
    legacyEvents.dispatchDefaultEvent = originalDispatch;
    legacyEvents.postEvent = originalPost;
  }
  t.end();
});

test('legacy guest calls restore reflective state and browser posts serialize', async (t) => {
  const previousFrame = { name: 'outer' };
  const previousResolver = () => {};
  const thread = {
    callStack: new Stack(),
    status: 'runnable',
    isAwaitingReflectiveCall: true,
    reflectiveCallFrame: previousFrame,
    reflectiveCallResolver: previousResolver,
  };
  thread.callStack.push(previousFrame);
  const method = {
    name: 'action',
    attributes: [{
      type: 'code',
      code: { localsSize: 3, codeItems: [], exceptionTable: [] },
    }],
  };
  const jvm = {
    threads: [thread],
    currentThreadIndex: 0,
    async executeTick() {
      const resolver = thread.reflectiveCallResolver;
      thread.callStack.pop();
      thread.isAwaitingReflectiveCall = false;
      thread.reflectiveCallFrame = null;
      thread.reflectiveCallResolver = null;
      resolver(1);
      return { completed: false };
    },
  };
  t.equal(await legacyEvents.runGuestMethod(
    jvm, 'Guest', method, [{}, {}, {}]), true);
  t.equal(thread.isAwaitingReflectiveCall, true);
  t.equal(thread.reflectiveCallFrame, previousFrame);
  t.equal(thread.reflectiveCallResolver, previousResolver);
  t.equal(thread.callStack.size(), 1);

  let activeLookups = 0;
  let maximumActiveLookups = 0;
  const queuedJvm = {
    async findMethodInHierarchy() {
      activeLookups++;
      maximumActiveLookups = Math.max(maximumActiveLookups, activeLookups);
      await new Promise((resolve) => setTimeout(resolve, 1));
      activeLookups--;
      return null;
    },
  };
  const source = { type: 'Guest', _parent: null };
  await Promise.all([
    legacyEvents.postActionEvent(queuedJvm, source, 'first'),
    legacyEvents.postActionEvent(queuedJvm, source, 'second'),
  ]);
  t.equal(maximumActiveLookups, 1,
    'browser-originated legacy events do not overlap on the shared thread');

  let scrollEvent = null;
  const scrollThread = { callStack: new Stack(), status: 'runnable' };
  const scrollMethod = {
    name: 'handleEvent',
    attributes: [{ type: 'code', code: {
      localsSize: '2', stackSize: '1', codeItems: [], exceptionTable: [],
    } }],
  };
  const scrollJvm = {
    threads: [scrollThread],
    currentThreadIndex: 0,
    async findMethodInHierarchy() { return scrollMethod; },
    async executeTick() {
      const frame = scrollThread.callStack.peek();
      scrollEvent = frame.locals[1];
      scrollThread.callStack.pop();
      scrollThread.reflectiveCallResolver(0);
      return { completed: false };
    },
  };
  const scrollbar = { type: 'java/awt/Scrollbar', _parent: null };
  await legacyEvents.postScrollEvent(scrollJvm, scrollbar, 605, 37);
  t.equal(scrollEvent.target, scrollbar,
    'legacy scroll events retain the scrollbar as their target');
  t.equal(scrollEvent.arg.type, 'java/lang/Integer');
  t.equal(scrollEvent.arg.value, 37,
    'legacy scroll events box the current scrollbar value as their argument');

  const originalNow = Date.now;
  Date.now = () => 4242;
  try {
    const event = legacyEvents.makeEvent({ id: 501, target: source });
    t.equal(event.when, 4242);
    t.equal(event.fields['java/awt/Event.when'], 4242n);
  } finally {
    Date.now = originalNow;
  }
  t.end();
});

test('legacy frame dispatch never wakes a monitor-blocked guest thread', async (t) => {
  const monitor = { isLocked: true, lockOwner: 7, lockCount: 1 };
  const outerFrame = { name: 'blocked-owner' };
  const blockedThread = {
    id: 2,
    callStack: new Stack(),
    status: 'BLOCKED',
    blockingOn: monitor,
    pendingException: null,
  };
  blockedThread.callStack.push(outerFrame);
  const jvm = {
    threads: [blockedThread],
    currentThreadIndex: 0,
    async executeTick() {
      const eventThread = this.threads.find((thread) => thread !== blockedThread);
      eventThread.callStack.pop();
      eventThread.status = 'terminated';
      return { completed: false };
    },
  };
  const eventFrame = { name: 'browser-event' };
  const result = await legacyEvents.runFrame(jvm, eventFrame, {
    thread: blockedThread,
  });

  t.ok(result.completed, 'the event completes on an independent AWT thread');
  t.equal(blockedThread.status, 'BLOCKED', 'the contended guest remains blocked');
  t.equal(blockedThread.blockingOn, monitor, 'the pending monitor is retained');
  t.equal(blockedThread.callStack.size(), 1,
    'the blocked guest stack is not changed by browser dispatch');
  t.equal(blockedThread.callStack.peek(), outerFrame,
    'the original monitor-protected frame remains current');
  t.equal(jvm.threads.length, 2, 'an AWT event thread owns the callback');
  t.end();
});

test('legacy default dispatch includes enter, exit, and key handlers', async (t) => {
  const lookups = [];
  const jvm = {
    async findMethodInHierarchy(type, name, descriptor) {
      lookups.push({ type, name, descriptor });
      return null;
    },
  };
  const component = { type: 'Guest' };
  await legacyEvents.dispatchDefaultEvent(jvm, component,
    { id: 504, x: 2, y: 3 });
  await legacyEvents.dispatchDefaultEvent(jvm, component,
    { id: 403, key: 37 });
  t.deepEqual(lookups, [
    { type: 'Guest', name: 'mouseEnter', descriptor: '(Ljava/awt/Event;II)Z' },
    { type: 'Guest', name: 'keyDown', descriptor: '(Ljava/awt/Event;I)Z' },
  ]);
  t.end();
});

test('GridLayout validates dimensions and derives effective grid size', (t) => {
  const init = GridLayout.methods['<init>(II)V'];
  t.throws(() => init({}, {}, [0, 0]), (error) =>
    error && error.type === 'java/lang/IllegalArgumentException');
  t.throws(() => init({}, {}, [-1, 2]), (error) =>
    error && error.type === 'java/lang/IllegalArgumentException');

  const oldDocument = global.document;
  global.document = {};
  try {
    const containerElement = element();
    const container = { _awtElement: containerElement };
    Container.methods['<init>()V']({}, container, []);
    const layout = { type: 'java/awt/GridLayout' };
    init({}, layout, [2, 2]);
    const jvm = { _jreFindMethod: () => null };
    Container.methods['setLayout(Ljava/awt/LayoutManager;)V'](
      jvm, container, [layout]);
    for (let i = 0; i < 5; i++) {
      Container.methods['add(Ljava/awt/Component;)Ljava/awt/Component;'](
        jvm, container, [{ _awtElement: element() }]);
    }
    t.equal(containerElement.style.gridTemplateRows,
      'repeat(2, minmax(0, 1fr))');
    t.equal(containerElement.style.gridTemplateColumns,
      'repeat(3, minmax(0, 1fr))');
  } finally {
    global.document = oldDocument;
  }
  t.end();
});

test('CardLayout registers named cards and re-lays out selections', (t) => {
  let layoutCalls = 0;
  const jvm = {
    _jreFindMethod(type, name, descriptor) {
      if (type === 'java/awt/CardLayout') {
        return CardLayout.methods[`${name}${descriptor}`] || null;
      }
      if (type === 'java/awt/Container' && name === 'doLayout') {
        return () => { layoutCalls++; };
      }
      return null;
    },
  };
  const container = {};
  Container.methods['<init>()V'](jvm, container, []);
  const layout = { type: 'java/awt/CardLayout' };
  CardLayout.methods['<init>()V'](jvm, layout, []);
  Container.methods['setLayout(Ljava/awt/LayoutManager;)V'](
    jvm, container, [layout]);
  const first = {};
  const second = {};
  Container.methods[
    'add(Ljava/lang/String;Ljava/awt/Component;)Ljava/awt/Component;'
  ](jvm, container, ['first', first]);
  Container.methods[
    'add(Ljava/lang/String;Ljava/awt/Component;)Ljava/awt/Component;'
  ](jvm, container, ['second', second]);
  t.equal(container._cards.first, first);
  t.equal(container._cards.second, second);
  CardLayout.methods['show(Ljava/awt/Container;Ljava/lang/String;)V'](
    jvm, layout, [container, 'second']);
  t.equal(container._currentCard, 'second');
  t.equal(layoutCalls, 1);
  CardLayout.methods['first(Ljava/awt/Container;)V'](
    jvm, layout, [container]);
  CardLayout.methods['last(Ljava/awt/Container;)V'](
    jvm, layout, [container]);
  t.equal(layoutCalls, 3);
  t.end();
});

test('legacy text, color, and primitive string contracts are preserved', (t) => {
  const area = {};
  TextArea.methods['<init>(Ljava/lang/String;III)V'](
    {}, area, ['text', -4, -7, 2]);
  t.equal(TextArea.methods['getRows()I']({}, area, []), 0);
  t.equal(TextArea.methods['getColumns()I']({}, area, []), 0);
  t.equal(TextArea.methods['getScrollbarVisibility()I']({}, area, []), 2);

  const field = {};
  TextField.methods['<init>(Ljava/lang/String;I)V'](
    {}, field, ['a\r\nb\nc', 8]);
  t.equal(field.text, 'a b c');
  t.equal(TextField.methods['getColumns()I']({}, field, []), 8);
  TextField.methods['setText(Ljava/lang/String;)V']({}, field, ['x\ry']);
  t.equal(field.text, 'x y');

  t.equal(Color.staticFields['RED:Ljava/awt/Color;'],
    Color.staticFields['red:Ljava/awt/Color;']);
  t.equal(Color.staticFields['DARK_GRAY:Ljava/awt/Color;'],
    Color.staticFields['darkGray:Ljava/awt/Color;']);

  const jvm = {
    internString: (value) => String(value),
    newString: (value) => String(value),
  };
  t.equal(StringClass.staticMethods['valueOf(J)Ljava/lang/String;'](
    jvm, null, [-9223372036854775808n]), '-9223372036854775808');
  t.equal(StringClass.staticMethods['valueOf(F)Ljava/lang/String;'](
    jvm, null, [-0]), '-0.0');
  t.equal(StringClass.staticMethods['valueOf(D)Ljava/lang/String;'](
    jvm, null, [0]), '0.0');
  t.equal(StringClass.staticMethods['valueOf(D)Ljava/lang/String;'](
    jvm, null, [5e-324]), '4.9E-324');
  t.end();
});

test('Canvas fillArc clamps full sweeps and preserves direction', (t) => {
  const calls = [];
  const context = {
    font: '',
    beginPath() {},
    moveTo() {},
    closePath() {},
    fill() {},
    ellipse(...args) { calls.push(args); },
  };
  const graphics = new awt._test.CanvasGraphics(context);
  graphics.fillArc(0, 0, 20, 10, 0, 90);
  graphics.fillArc(0, 0, 20, 10, 0, -90);
  graphics.fillArc(0, 0, 20, 10, 0, 720);
  t.equal(calls[0][7], true, 'positive Java sweeps use Canvas anticlockwise mode');
  t.equal(calls[1][7], false, 'negative Java sweeps use Canvas clockwise mode');
  t.ok(Math.abs((calls[2][6] - calls[2][5]) + Math.PI * 2) < 1e-12,
    'sweeps larger than one turn clamp to a full circle');
  t.end();
});

test('Applet backdrop remains visible inside its stacking context', (t) => {
  const oldDocument = global.document;
  const container = element();
  global.document = {
    getElementById: (id) => id === 'awt-container' ? container : null,
    createElement: (tagName) => {
      const created = element(tagName);
      if (tagName === 'canvas') {
        created.getContext = () => ({
          font: '',
          clearRect() {},
          fillRect() {},
        });
      }
      return created;
    },
  };
  try {
    const applet = {};
    Applet.methods['<init>()V']({}, applet, []);
    const root = container.querySelector('.awt-applet-root');
    t.equal(root.style.zIndex, '0');
    t.equal(applet._canvasElement.style.zIndex, '-1');
    t.ok(root.contains(applet._canvasElement));
  } finally {
    global.document = oldDocument;
  }
  t.end();
});

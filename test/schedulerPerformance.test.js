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
  const timerJvm = new JVM({ eventLoopYieldStrategy: 'timer' });
  t.equal(timerJvm.eventLoopYieldStrategy, 'timer',
    'browser callers can select a paint-friendly timer yield');
  const defaultJvm = new JVM();
  t.equal(defaultJvm.eventLoopYieldStrategy, 'message-channel',
    'the default avoids repeatedly clamped browser timers');
  const messageJvm = new JVM({ eventLoopYieldStrategy: 'message-channel' });
  t.equal(messageJvm.eventLoopYieldStrategy, 'message-channel',
    'latency-sensitive callers can explicitly select MessageChannel yielding');
  t.end();
});

test('dropped guest frames convert a scheduler yield into a paint opportunity',
  (t) => {
    const jvm = new JVM({ eventLoopYieldStrategy: 'message-channel' });
    t.equal(jvm.awtPresentationBackpressureFrames, 2,
      'frame-production backpressure is on by default');
    t.equal(jvm._hostYieldStrategy(), 'message-channel',
      'a guest that keeps up with the presenter keeps the fast yield');
    jvm._awtDroppedFrameBacklog = 1;
    t.equal(jvm._hostYieldStrategy(), 'message-channel',
      'a single superseded frame is ordinary coalescing, not over-production');
    jvm._awtDroppedFrameBacklog = 2;
    t.equal(jvm._hostYieldStrategy(), 'timer',
      'a backlog of dropped frames yields through a rendering opportunity');
    t.equal(jvm._awtDroppedFrameBacklog, 0,
      'each rendering opportunity consumes the backlog that earned it');
    t.equal(jvm._hostYieldStrategy(), 'message-channel',
      'the fast yield resumes until the guest drops more frames');

    const disabled = new JVM({
      eventLoopYieldStrategy: 'message-channel',
      awtPresentationBackpressureFrames: 0,
    });
    disabled._awtDroppedFrameBacklog = 99;
    t.equal(disabled._hostYieldStrategy(), 'message-channel',
      'backpressure is switchable off without touching the yield strategy');

    const timerJvm = new JVM({ eventLoopYieldStrategy: 'timer' });
    timerJvm._awtDroppedFrameBacklog = 99;
    t.equal(timerJvm._hostYieldStrategy(), 'timer',
      'a caller already yielding through timers is unaffected');

    const previousRaf = global.requestAnimationFrame;
    const previousDocument = global.document;
    global.requestAnimationFrame = () => 1;
    global.document = {};
    const painting = new JVM({ eventLoopYieldStrategy: 'message-channel' });
    painting._awtDroppedFrameBacklog = 4;
    t.equal(painting._hostYieldStrategy(), 'presentation',
      'a painting host parks the guest until the pending frame is presented');
    painting._awtDroppedFrameBacklog = 0;
    painting._awtIncrementalPresentationPending = true;
    t.equal(painting._hostYieldStrategy(), 'presentation',
      'an exact partial-frame signal also waits for its scheduled paint');
    painting._awtIncrementalPresentationPending = false;
    painting._awtDirectPresentationPendingYield = true;
    t.equal(painting._hostYieldStrategy(), 'timer',
      'an exact direct upload receives one browser-paint task boundary');
    t.notOk(painting._awtDirectPresentationPendingYield,
      'the direct-upload task boundary is consumed once');
    if (previousRaf === undefined) delete global.requestAnimationFrame;
    else global.requestAnimationFrame = previousRaf;
    if (previousDocument === undefined) delete global.document;
    else global.document = previousDocument;
    t.end();
  });

test('a parked guest resumes on the presentation, and on a bounded timer',
  (t) => {
    const jvm = new JVM({ eventLoopYieldMs: 16 });
    const startedAt = Date.now();
    jvm._awaitPresentation().then(() => {
      t.ok(Date.now() - startedAt < 20,
        'the presentation itself releases the guest, not the safety timer');
      t.deepEqual(jvm._awtPresentationWaiters, [],
        'a released waiter is not retained across presentations');
      const withoutPresentation = Date.now();
      return jvm._awaitPresentation().then(() => {
        t.ok(Date.now() - withoutPresentation >= 20,
          'a host that never presents still resumes on the bounded timer');
        t.end();
      });
    });
    // Stand in for the AWT presenter completing an upload.
    setTimeout(() => {
      const waiters = jvm._awtPresentationWaiters;
      jvm._awtPresentationWaiters = [];
      waiters.forEach((resume) => resume());
    }, 1);
  });

test('a rendering host resumes a timer yield from a real timer task', (t) => {
  const { yieldToEventLoop } = require('../src/core/jvm');
  const previousRaf = global.requestAnimationFrame;
  const previousDocument = global.document;
  const previousImmediate = global.setImmediate;
  const previousTimeout = global.setTimeout;
  const used = [];
  global.requestAnimationFrame = () => 1;
  global.document = {};
  global.setImmediate = (callback) => {
    used.push('immediate');
    return previousImmediate(callback);
  };
  global.setTimeout = (callback, ms) => {
    used.push(`timeout:${ms}`);
    return previousTimeout(callback, ms);
  };
  const restore = () => {
    global.setTimeout = previousTimeout;
    global.setImmediate = previousImmediate;
    if (previousRaf === undefined) delete global.requestAnimationFrame;
    else global.requestAnimationFrame = previousRaf;
    if (previousDocument === undefined) delete global.document;
    else global.document = previousDocument;
  };
  yieldToEventLoop(0, 'timer')
    .then(() => yieldToEventLoop(0, 'message-channel'))
    .then(() => {
      restore();
      t.deepEqual(used, ['timeout:0', 'immediate'],
        'only the timer strategy leaves the continuously runnable task queue');
      t.end();
    })
    .catch((error) => { restore(); t.fail(error); t.end(); });
});

test('deterministic scheduler never waits on wall time', (t) => {
  const jvm = new JVM({ fakeTime: 1000, eventLoopYieldMs: 16 });
  jvm.threads = [{ status: 'SLEEPING', sleepUntil: 2000 }];
  t.equal(jvm._idleWaitDelay(1010), 0);
  t.end();
});

test('serial scheduler does not starve low-priority guest work', (t) => {
  const jvm = new JVM();
  const high = {
    status: 'runnable', javaThread: {priority: 10}, callStack: new Stack(),
  };
  const low = {
    status: 'runnable', javaThread: {priority: 1}, callStack: new Stack(),
  };
  jvm.threads = [high, low];
  jvm.currentThreadIndex = 0;
  const selections = [0, 0];
  for (let quantum = 0; quantum < 20; quantum += 1) {
    selections[jvm.currentThreadIndex] += 1;
    jvm._advanceSchedulerThread();
  }
  t.deepEqual(selections, [10, 10],
    'one host thread gives both guest priorities bounded progress');
  t.end();
});

test('AWT input handlers supersede a continuously runnable frame producer', (t) => {
  const jvm = new JVM();
  const producer = { status: 'runnable', callStack: new Stack() };
  const eventThread = { status: 'runnable', callStack: new Stack() };
  producer.callStack.push({ method: { name: 'render' } });
  eventThread.callStack.push({ method: { name: 'mouseMoved' } });
  jvm.threads = [producer, eventThread];
  jvm.currentThreadIndex = 0;
  jvm._awtFrameProducerThread = producer;
  jvm._awtEventThread = eventThread;

  t.equal(jvm._prepareSchedulerTick().thread, eventThread,
    'a queued input callback receives a scheduler turn before rendering');

  eventThread.status = 'terminated';
  eventThread.callStack.items.length = 0;
  t.equal(jvm._prepareSchedulerTick().thread, producer,
    'the frame producer regains priority as soon as the callback completes');
  t.end();
});

test('scheduler stack limit is configurable for recursive-call diagnostics', (t) => {
  const configured = new JVM({ maxStackDepth: 73 });
  const invalid = new JVM({ maxStackDepth: 0 });

  t.equal(configured.maxStackDepth, 73,
    'diagnostic runs can lower the guest stack limit without changing bytecode');
  t.equal(invalid.maxStackDepth, 1024,
    'invalid stack limits retain the production default');
  t.end();
});

test('scheduler wall-time sampling can be enabled without process environment', (t) => {
  const jvm = new JVM({ schedulerTimingRate: 256 });
  t.ok(jvm._schedulerTimingProfile,
    'browser callers can opt into sampled scheduler timing');
  t.equal(jvm._schedulerTimingProfile.rate, 256,
    'the configured sampling rate is retained');
  jvm._schedulerTimingProfile.samples.set('Arbitrary.loop()V', {
    samples: 3,
    totalMs: 12.5,
    maxMs: 7.25,
  });
  t.deepEqual(jvm.getSchedulerTimingSnapshot(1), {
    rate: 256,
    rows: [{
      method: 'Arbitrary.loop()V',
      samples: 3,
      totalMs: 12.5,
      maxMs: 7.25,
      synchronousMs: 0,
      asyncWaitMs: 0,
      awaitedSamples: 0,
      slowPathSamples: 0,
    }],
  }, 'diagnostics expose sampled time without enabling invocation profiling');
  t.end();
});

test('scheduler wall-time sampling can be reconfigured at runtime', (t) => {
  const jvm = new JVM();
  t.equal(jvm.getSchedulerTimingSnapshot(), null,
    'sampling starts disabled');
  t.deepEqual(jvm.configureSchedulerTimings(32), {
    rate: 32,
    rows: [],
  }, 'a browser diagnostic can enable sampling for one region');
  jvm._schedulerTimingProfile.samples.set('Fixture.work()V', {
    samples: 1,
    totalMs: 2,
    maxMs: 2,
  });
  t.equal(jvm.getSchedulerTimingSnapshot().rows.length, 1,
    'the enabled region records samples');
  t.equal(jvm.configureSchedulerTimings(0), null,
    'zero disables sampling');
  t.equal(jvm.getSchedulerTimingSnapshot(), null,
    'disabled sampling retains no stale region');
  t.end();
});

test('class initialization remains owned until bytecode clinit returns', async (t) => {
  const clinit = {
    name: '<clinit>',
    descriptor: '()V',
    flags: ['static'],
    attributes: [{
      type: 'code',
      code: {
        localsSize: '0',
        exceptionTable: [],
        codeItems: [{labelDef: 'L0:', instruction: 'return'}],
      },
    }],
  };
  const jvm = new JVM({jit: {enabled: false}});
  jvm.classes.InitializationOwner = {
    ast: {classes: [{
      className: 'InitializationOwner',
      superClassName: null,
      items: [
        {type: 'field', field: {
          name: 'value', descriptor: 'I', flags: ['static'],
        }},
        {type: 'method', method: clinit},
      ],
    }]},
    staticFields: new Map(),
  };
  const owner = {id: 1, status: 'runnable', callStack: new Stack()};
  const waiter = {id: 2, status: 'runnable', callStack: new Stack()};
  jvm.threads = [owner, waiter];

  t.equal(await jvm.initializeClassIfNeeded('InitializationOwner', owner), true,
    'the owner receives the initializer frame');
  t.equal(jvm.classInitializationState.get('InitializationOwner'), 'INITIALIZING',
    'the class is not published before clinit executes');
  t.equal(jvm.classInitializationOwners.get('InitializationOwner'), owner.id,
    'the initializing thread owns the class lock');
  t.equal(await jvm.initializeClassIfNeeded('InitializationOwner', owner), false,
    'recursive access by the owner is allowed');
  t.equal(await jvm.initializeClassIfNeeded('InitializationOwner', waiter), true,
    'another thread defers its triggering instruction');
  t.equal(waiter.status, 'CLASS_INITIALIZATION_WAIT',
    'the other thread waits instead of observing default statics');

  jvm.currentThreadIndex = 0;
  await jvm.executeTick({allowBurst: true});
  t.equal(jvm.classInitializationState.get('InitializationOwner'), 'INITIALIZED',
    'normal clinit return publishes the initialized class');
  t.equal(waiter.status, 'runnable', 'completion wakes initialization waiters');
  t.notOk(jvm.classInitializationOwners.has('InitializationOwner'),
    'the initialization owner is released');
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
  t.equal(typeof codeItems[1][instructions.syncHandler], 'function',
    'invoke opcode receives a guarded warm-target handler');
  t.deepEqual(codeItems[2][instructions.syncInstruction],
    { op: 'iinc', varnum: '2', incr: '3' }, 'wide opcode is expanded once');
  instructions.prepareSyncInstructions(codeItems);
  t.equal(codeItems[0][instructions.syncHandler], firstHandler,
    'preparing the same shared method body is idempotent');
  t.deepEqual(Object.keys(codeItems[0]), ['instruction'],
    'prepared dispatch metadata is not serialized or shown by debuggers');
  t.end();
});

test('interpreter applies dup2_x1 category-2 semantics to doubles', async (t) => {
  const method = {
    name: 'copyDouble',
    descriptor: '(D)V',
    flags: ['public'],
    attributes: [{
      type: 'code',
      code: {
        localsSize: '3',
        exceptionTable: [],
        codeItems: [
          { instruction: 'aload_0' },
          { instruction: 'aload_0' },
          { instruction: 'dload_1' },
          { instruction: 'dup2_x1' },
          { instruction: { op: 'putfield', arg: [null, 'Pair', ['first', 'D']] } },
          { instruction: { op: 'putfield', arg: [null, 'Pair', ['second', 'D']] } },
          { instruction: 'return' },
        ],
      },
    }],
  };
  const pair = {
    type: 'Pair',
    fields: {
      'Pair.first': 0,
      'Pair.second': 0,
    },
  };
  const jvm = new JVM({ interpreterBurst: 16, jit: { enabled: false } });
  jvm.classes.Pair = {
    ast: { classes: [{ className: 'Pair', superClassName: null }] },
    staticFields: new Map(),
  };
  const thread = { id: 0, status: 'runnable', callStack: new Stack() };
  const frame = new Frame(method);
  frame.locals[0] = pair;
  frame.locals[1] = 6.25;
  thread.callStack.push(frame);
  jvm.threads = [thread];

  const result = await jvm.executeTick({ allowBurst: true });
  t.equal(result.bytecodes, 7, 'the complete bytecode shape executes in one quantum');
  t.equal(pair.fields['Pair.first'], 6.25, 'the first putfield receives the double');
  t.equal(pair.fields['Pair.second'], 6.25, 'the duplicated double reaches the second putfield');
  t.equal(thread.callStack.size(), 0, 'the method returns with a balanced operand stack');
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

test('synchronous interpreter quanta do not manufacture a Promise', (t) => {
  const method = {
    name: 'synchronousInterpreterQuantum', descriptor: '()V', flags: ['static'],
    attributes: [{type: 'code', code: {
      localsSize: '1', exceptionTable: [],
      codeItems: [
        {instruction: 'iconst_0'},
        {instruction: 'istore_0'},
        {instruction: {op: 'iinc', varnum: 0, incr: 1}},
        {instruction: 'return'},
      ],
    }}],
  };
  const jvm = new JVM({interpreterBurst: 16, jit: {enabled: false}});
  const thread = {id: 0, status: 'runnable', callStack: new Stack()};
  const frame = new Frame(method);
  thread.callStack.push(frame);
  jvm.threads = [thread];
  const scheduled = {thread, callStack: thread.callStack, schedulerNow: 0};

  const result = jvm._tryExecuteSynchronousInterpreterTick(scheduled, true);
  t.notOk(result && typeof result.then === 'function',
    'a fully synchronous bytecode quantum returns directly');
  t.equal(frame.locals[0], 1,
    'the allocation-free path executes the complete same-frame body');
  t.ok(thread.callStack.isEmpty(),
    'the normal return retires the frame through the canonical handler');
  t.end();
});

test('synchronous generated entries do not manufacture a Promise', (t) => {
  const method = {
    name: 'constant',
    descriptor: '()I',
    flags: ['static'],
    attributes: [{
      type: 'code',
      code: {
        localsSize: '0',
        exceptionTable: [],
        codeItems: [
          { labelDef: 'L0:', instruction: 'iconst_3' },
          { labelDef: 'L1:', instruction: 'iconst_4' },
          { labelDef: 'L2:', instruction: 'iadd' },
          { labelDef: 'L3:', instruction: 'ireturn' },
        ],
      },
    }],
  };
  const jvm = new JVM({ jit: { warmupThreshold: 0 } });
  const thread = { id: 0, status: 'runnable', callStack: new Stack() };
  const frame = new Frame(method);
  frame.className = 'Test';
  thread.callStack.push(frame);
  jvm.threads = [thread];

  const result = jvm.jit.tryRunFrame(frame, thread);
  t.notOk(result && typeof result.then === 'function',
    'the generated hot path returns its result directly');
  t.ok(result && result.handled, 'the generated entry was handled');
  t.equal(thread.callStack.size(), 0, 'the generated return completed the frame');
  t.end();
});

test('the execution scheduler keeps synchronous generated ticks off the Promise path', (t) => {
  const method = {
    name: 'constant',
    descriptor: '()I',
    flags: ['static'],
    attributes: [{
      type: 'code',
      code: {
        localsSize: '0',
        exceptionTable: [],
        codeItems: [
          { labelDef: 'L0:', instruction: 'iconst_3' },
          { labelDef: 'L1:', instruction: 'iconst_4' },
          { labelDef: 'L2:', instruction: 'iadd' },
          { labelDef: 'L3:', instruction: 'ireturn' },
        ],
      },
    }],
  };
  const jvm = new JVM({ jit: { warmupThreshold: 0 } });
  const thread = { id: 0, status: 'runnable', callStack: new Stack() };
  const frame = new Frame(method);
  frame.className = 'Test';
  thread.callStack.push(frame);
  jvm.threads = [thread];

  const scheduled = jvm._prepareSchedulerTick();
  const result = jvm._tryExecuteSynchronousJitTick(scheduled);
  t.notOk(result && typeof result.then === 'function',
    'the scheduler fast path itself stays synchronous');
  t.notOk(result.slow, 'the generated frame did not fall back to executeTick');
  t.equal(thread.callStack.size(), 0, 'the generated return completed the frame');
  t.end();
});

test('the scheduler batches bounded same-thread generated frames', (t) => {
  const method = {
    name: 'complete', descriptor: '()V', flags: ['static'],
    attributes: [{ type: 'code', code: {
      localsSize: '0', exceptionTable: [],
      codeItems: [
        { labelDef: 'L0:', instruction: 'iconst_1' },
        { labelDef: 'L1:', instruction: 'iconst_2' },
        { labelDef: 'L2:', instruction: 'iadd' },
        { labelDef: 'L3:', instruction: 'pop' },
        { labelDef: 'L4:', instruction: 'return' },
      ],
    } }],
  };
  const jvm = new JVM({ generatedSchedulerBurst: 8,
    jit: { warmupThreshold: 0 } });
  const thread = { id: 0, status: 'runnable', callStack: new Stack() };
  const parent = new Frame(method);
  parent.className = 'ArbitraryOwner';
  const child = new Frame(method);
  child.className = 'ArbitraryOwner';
  thread.callStack.push(parent);
  thread.callStack.push(child);
  jvm.threads = [thread];

  const result = jvm._tryExecuteSynchronousJitTick(
    jvm._prepareSchedulerTick());
  t.notOk(result.slow,
    'two warmed frames complete without a scheduler slow-path round trip');
  t.equal(thread.callStack.size(), 0,
    'the bounded burst executes the exposed parent after its child');
  t.equal(jvm.generatedSchedulerBurstFrames, 2,
    'the burst accounts for both generated frames');
  t.equal(jvm.generatedSchedulerBurstBatches, 1,
    'the two frames share one scheduler batch');
  t.end();
});

test('warm interpreted call sites cache arbitrary loaded bytecode targets', async (t) => {
  const callee = {
    name: 'renamedLeaf', descriptor: '()I', flags: ['static'],
    attributes: [{ type: 'code', code: {
      localsSize: '0', exceptionTable: [], codeItems: [
        { instruction: { op: 'bipush', arg: '37' } }, { instruction: 'ireturn' },
      ],
    } }],
  };
  const caller = {
    name: 'renamedCaller', descriptor: '()I', flags: ['static'],
    attributes: [{ type: 'code', code: {
      localsSize: '0', exceptionTable: [], codeItems: [
        { instruction: { op: 'invokestatic',
          arg: [null, 'ArbitraryOwner', ['renamedLeaf', '()I']] } },
        { instruction: 'ireturn' },
      ],
    } }],
  };
  const jvm = new JVM({ interpreterBurst: 16, jit: { enabled: false } });
  jvm.classes.ArbitraryOwner = {
    ast: { classes: [{ className: 'ArbitraryOwner', superClassName: null,
      items: [{ type: 'method', method: callee }, { type: 'method', method: caller }] }] },
    staticFields: new Map(),
  };
  jvm.classInitializationState.set('ArbitraryOwner', 'INITIALIZED');
  const thread = { id: 0, status: 'runnable', callStack: new Stack() };
  const sink = new Frame({ name: 'sink', descriptor: '()V', attributes: [] });
  const frame = new Frame(caller);
  frame.className = 'ArbitraryOwner';
  thread.callStack.push(sink);
  thread.callStack.push(frame);
  jvm.threads = [thread];

  while (thread.callStack.size() > 1) await jvm.executeTick({ allowBurst: true });
  t.equal(sink.stack.pop(), 37, 'cached structural target preserves the return value');
  t.end();
});

test('cached native call sites retain genuinely asynchronous results', async (t) => {
  const owner = 'ArbitraryAsyncNative';
  const previous = require('../src/jre')[owner];
  require('../src/jre')[owner] = {
    methods: { 'renamedValue()I': () => Promise.resolve(41) },
  };
  t.teardown(() => {
    if (previous === undefined) delete require('../src/jre')[owner];
    else require('../src/jre')[owner] = previous;
  });
  const method = {
    name: 'caller', descriptor: '()I', flags: ['static'],
    attributes: [{ type: 'code', code: {
      localsSize: '0', exceptionTable: [], codeItems: [
        { instruction: { op: 'invokestatic',
          arg: [null, owner, ['renamedValue', '()I']] } },
        { instruction: 'ireturn' },
      ],
    } }],
  };
  const jvm = new JVM({ interpreterBurst: 16, jit: { enabled: false } });
  jvm.jre[owner] = require('../src/jre')[owner];
  jvm.classes[owner] = {
    ast: { classes: [{ className: owner, superClassName: null, items: [] }] },
    staticFields: new Map(),
  };
  jvm.classInitializationState.set(owner, 'INITIALIZED');
  const thread = { id: 0, status: 'runnable', callStack: new Stack() };
  const sink = new Frame({ name: 'sink', descriptor: '()V', attributes: [] });
  const frame = new Frame(method);
  frame.className = 'Caller';
  thread.callStack.push(sink);
  thread.callStack.push(frame);
  jvm.threads = [thread];

  while (thread.callStack.size() > 1) await jvm.executeTick({ allowBurst: true });
  t.equal(sink.stack.pop(), 41, 'Promise result is awaited and returned normally');
  t.end();
});

test('explicit preparation can limit Wasm to prepared oversized upgrades',
  async (t) => {
  const ordinary = {name: 'ordinary', descriptor: '()V', flags: [],
    attributes: [{type: 'code', code: {codeItems: [], exceptionTable: []}}]};
  const oversized = {name: 'oversized', descriptor: '()V', flags: [],
    attributes: [{type: 'code', code: {codeItems: [], exceptionTable: []}}]};
  const jvm = new JVM();
  jvm.classes.ArbitraryPreparedOwner = {
    ast: {classes: [{items: [
      {type: 'method', method: ordinary},
      {type: 'method', method: oversized},
    ]}]},
    staticFields: new Map(),
  };
  jvm.classInitializationState.set('ArbitraryPreparedOwner', 'INITIALIZED');
  jvm.jit.getGeneratedFunction = method => {
    jvm.jit.preparedCodegenMethods.add(method);
    return () => ({returned: true});
  };
  jvm.jit.hasBackwardBranch = () => true;
  jvm.jit.isOversizedLoopMethod = method => method === oversized;
  jvm.jit.jitDenied = () => false;
  jvm.jit.wasmJit.enabled = true;
  jvm.jit.wasmJit.methodState = ({method}) => ({status: 'cold', method});
  const compiled = [];
  jvm.jit.wasmJit.compile = ({method}) => compiled.push(method);

  const result = await jvm.precompileInitializedClasses({
    wasm: true, effectful: true, wasmPreparedUpgradesOnly: true,
  });
  t.equal(result.methods, 2,
    'JavaScript preparation still covers every selected method');
  t.deepEqual(compiled, [oversized],
    'the Wasm pass compiles only a prepared oversized upgrade');
  t.equal(result.wasmMethods, 1,
    'progress reports only the selected Wasm upgrade');
  t.end();
});

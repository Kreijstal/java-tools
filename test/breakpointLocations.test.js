const test = require('tape');
const path = require('path');
const DebugController = require('../src/debug/debugController');
const DebugManager = require('../src/debug/DebugManager');
const {
  resolveBreakpoint, methodCandidates, complete,
} = require('../src/debug/breakpointResolver');

const SOURCES = path.join(__dirname, '..', 'sources');

function controller() {
  return new DebugController({ classpath: [SOURCES], jit: { enabled: false } });
}

test('an unlocated breakpoint still fires anywhere', (t) => {
  const manager = new DebugManager();
  manager.addBreakpoint(6);
  t.equal(manager.shouldBreakAt(6, { className: 'Any', methodName: 'm' }), true,
    'matches an arbitrary frame');
  t.equal(manager.shouldBreakAt(7, { className: 'Any' }), false,
    'a different offset does not match');
  t.end();
});

test('a located breakpoint fires only in its own class and method', (t) => {
  const manager = new DebugManager();
  manager.addStrictBreakpoint(6, {
    className: 'Foo', methodName: 'main', descriptor: '([Ljava/lang/String;)V',
  });

  t.equal(manager.shouldBreakAt(6, {
    className: 'Foo', methodName: 'main', descriptor: '([Ljava/lang/String;)V',
  }), true, 'matches the exact frame');

  // The behaviour this replaced: offset 6 stopped in every method that
  // happened to reach instruction offset 6.
  t.equal(manager.shouldBreakAt(6, {
    className: 'Unrelated', methodName: 'run', descriptor: '()V',
  }), false, 'does not fire in an unrelated class');
  t.equal(manager.shouldBreakAt(6, {
    className: 'Foo', methodName: 'other', descriptor: '()V',
  }), false, 'does not fire in a sibling method of the same class');
  t.end();
});

test('a class-level location matches any method in that class', (t) => {
  const manager = new DebugManager();
  manager.addStrictBreakpoint(3, { className: 'Foo' });
  t.equal(manager.shouldBreakAt(3, { className: 'Foo', methodName: 'a' }), true);
  t.equal(manager.shouldBreakAt(3, { className: 'Bar', methodName: 'a' }), false);
  t.end();
});

test('breakpoints resolve from a method name instead of an offset', async (t) => {
  const debug = controller();
  await debug.start('SimpleArithmetic', { args: [] });

  const target = debug.setBreakpointAt('SimpleArithmetic.main');
  t.equal(target.className, 'SimpleArithmetic', 'resolved the class');
  t.equal(target.methodName, 'main', 'resolved the method');
  t.equal(target.descriptor, '([Ljava/lang/String;)V', 'resolved the descriptor');
  t.equal(typeof target.pc, 'number', 'produced a bytecode offset');

  const offset = debug.setBreakpointAt('SimpleArithmetic.main+6');
  t.equal(offset.pc, 6, 'an explicit +offset is honoured');

  t.end();
});

test('breakpoints resolve from a source line', async (t) => {
  const debug = controller();
  await debug.start('SimpleArithmetic', { args: [] });

  // int sum = a + b;  — line 5 of sources/SimpleArithmetic.java
  const target = debug.setBreakpointAt('SimpleArithmetic.java:5');
  t.equal(target.className, 'SimpleArithmetic', 'mapped the line to its class');
  t.equal(target.line, 5, 'reported the requested line');
  t.equal(typeof target.pc, 'number', 'mapped the line to an offset');
  t.end();
});

test('unresolvable locations are reported, not silently accepted', async (t) => {
  const debug = controller();
  await debug.start('SimpleArithmetic', { args: [] });

  t.throws(() => debug.setBreakpointAt('SimpleArithmetic.nosuch'),
    /No method/, 'unknown method');
  t.throws(() => debug.setBreakpointAt('SimpleArithmetic.main+7777'),
    /not an instruction boundary/, 'offset that is not an instruction start');
  t.throws(() => debug.setBreakpointAt('SimpleArithmetic.java:9999'),
    /No code at line/, 'line with no code');
  t.end();
});

test('a bare offset stays an unlocated breakpoint', async (t) => {
  const debug = controller();
  await debug.start('SimpleArithmetic', { args: [] });
  const target = debug.setBreakpointAt('6');
  t.equal(target.pc, 6, 'parsed the offset');
  t.equal(target.className, undefined, 'no location bound');
  t.end();
});

test('completion offers class and method names', async (t) => {
  const debug = controller();
  await debug.start('SimpleArithmetic', { args: [] });

  const names = methodCandidates(debug.jvm);
  t.ok(names.includes('SimpleArithmetic.main'), 'lists Class.method pairs');

  const result = complete(debug.jvm, 'SimpleArith');
  t.ok(result.matches.length > 0, 'matches a partial class name');
  t.ok(result.completion.startsWith('SimpleArith'),
    'extends the typed prefix: ' + result.completion);

  const method = complete(debug.jvm, 'SimpleArithmetic.m');
  t.ok(method.matches.some((name) => name === 'SimpleArithmetic.main'),
    'completes a partial method name');
  t.end();
});

test('the classpath can be read and edited live', async (t) => {
  const debug = controller();
  await debug.start('SimpleArithmetic', { args: [] });

  t.deepEqual(debug.getClasspath(), [SOURCES], 'reports the starting classpath');

  debug.addClasspath('/tmp/extra-classes');
  t.deepEqual(debug.getClasspath(), [SOURCES, '/tmp/extra-classes'], 'appends');
  t.equal(debug.jvm.classpath[1], '/tmp/extra-classes',
    'the JVM resolves against the edited list');

  debug.addClasspath('/tmp/extra-classes');
  t.equal(debug.getClasspath().length, 2, 'appending a duplicate is a no-op');

  debug.removeClasspath(1);
  t.deepEqual(debug.getClasspath(), [SOURCES], 'removes by index');

  debug.setClasspath(['/a', '/b']);
  t.deepEqual(debug.getClasspath(), ['/a', '/b'], 'replaces wholesale');

  t.throws(() => debug.removeClasspath('/not-there'), /Not on the classpath/,
    'removing an absent entry is an error');
  t.end();
});

test('an overloaded method is never guessed at', async (t) => {
  const debug = controller();
  await debug.start('OverloadDemo', { args: [] });

  t.throws(() => debug.setBreakpointAt('OverloadDemo.emit'),
    /is overloaded — choose one/, 'a bare overloaded name is refused');

  try {
    debug.setBreakpointAt('OverloadDemo.emit');
  } catch (error) {
    // The alternatives must be typeable, not raw JVM descriptors.
    t.ok(/emit\(int\)/.test(error.message),
      'lists the Java signature emit(int): ' + error.message);
    t.ok(/emit\(String\)/.test(error.message), 'lists emit(String)');
    t.ok(/emit\(int, long\)/.test(error.message), 'lists emit(int, long)');
    t.ok(!/\(I\)V/.test(error.message), 'does not demand a JVM descriptor');
  }
  t.end();
});

test('overloads are selected by Java signature, arity, or descriptor', async (t) => {
  const debug = controller();
  await debug.start('OverloadDemo', { args: [] });

  const byJava = debug.setBreakpointAt('OverloadDemo.emit(String)');
  t.equal(byJava.descriptor, '(Ljava/lang/String;)V',
    'Java-style parameter list picks the String overload');

  const byInt = debug.setBreakpointAt('OverloadDemo.emit(int)');
  t.equal(byInt.descriptor, '(I)V', 'picks the int overload');

  const byTwo = debug.setBreakpointAt('OverloadDemo.emit(int, long)');
  t.equal(byTwo.descriptor, '(IJ)V', 'picks the two-parameter overload');

  const byArity = debug.setBreakpointAt('OverloadDemo.emit/2');
  t.equal(byArity.descriptor, '(IJ)V', 'arity selects the unique 2-arg overload');

  const byDescriptor = debug.setBreakpointAt('OverloadDemo.emit(I)V');
  t.equal(byDescriptor.descriptor, '(I)V', 'an exact descriptor still works');

  t.throws(() => debug.setBreakpointAt('OverloadDemo.emit/1'),
    /is overloaded — choose one/, 'an arity matching two overloads stays ambiguous');
  t.throws(() => debug.setBreakpointAt('OverloadDemo.emit(double)'),
    /No OverloadDemo\.emit\(double\)/, 'an unmatched signature is reported');
  t.end();
});

test('Class.method* arms every overload', async (t) => {
  const debug = controller();
  await debug.start('OverloadDemo', { args: [] });

  const result = debug.setBreakpointAt('OverloadDemo.emit*');
  t.equal(result.targets.length, 3, 'one breakpoint per overload');
  const descriptors = result.targets.map((entry) => entry.descriptor).sort();
  t.deepEqual(descriptors, ['(I)V', '(IJ)V', '(Ljava/lang/String;)V'],
    'covers all three overloads');
  t.end();
});

test('completion offers typeable overload signatures', async (t) => {
  const debug = controller();
  await debug.start('OverloadDemo', { args: [] });

  const { matches } = debug.completeLocation('OverloadDemo.emit');
  t.ok(matches.includes('OverloadDemo.emit(int)'), 'offers emit(int)');
  t.ok(matches.includes('OverloadDemo.emit(String)'), 'offers emit(String)');
  t.ok(matches.includes('OverloadDemo.emit*'), 'offers the all-overloads form');
  t.end();
});

test('a chosen overload actually halts execution there', async (t) => {
  const debug = controller();
  await debug.start('OverloadDemo', { args: [] });
  debug.setBreakpointAt('OverloadDemo.emit(String)');
  await debug.continue();

  const state = debug.getCurrentState();
  t.equal(state.executionState, 'paused', 'stopped rather than running to the end');
  t.equal(state.method.name, 'emit', 'stopped inside emit');
  t.equal(state.method.descriptor, '(Ljava/lang/String;)V',
    'stopped in the String overload, not the int one that runs first');
  t.end();
});

test('raw JVM descriptors are completable too', async (t) => {
  const debug = controller();
  await debug.start('OverloadDemo', { args: [] });

  const { matches } = debug.completeLocation('OverloadDemo.emit');
  t.ok(matches.includes('OverloadDemo.emit(I)V'),
    'offers the raw descriptor for the int overload');
  t.ok(matches.includes('OverloadDemo.emit(Ljava/lang/String;)V'),
    'offers the raw descriptor for the String overload');
  t.ok(matches.includes('OverloadDemo.emit(int)'),
    'still offers the readable Java form alongside it');

  // The descriptor escape hatch is only useful if a prefix narrows to it.
  const narrowed = debug.completeLocation('OverloadDemo.emit(L');
  t.deepEqual(narrowed.matches, ['OverloadDemo.emit(Ljava/lang/String;)V'],
    'a descriptor prefix narrows to exactly one candidate');
  t.equal(narrowed.completion, 'OverloadDemo.emit(Ljava/lang/String;)V',
    'and completes it in full without further typing');

  t.end();
});

test('breakpoints reach classes in other packages', async (t) => {
  const debug = controller();
  await debug.start('PackageMain', { args: [] });
  // Reach the packaged class first, so this test covers syntax only.
  for (let i = 0; i < 400 && !debug.jvm.classes['pkg/demo/Greeter']; i += 1) {
    await debug.jvmStep();
  }
  t.ok(debug.jvm.classes['pkg/demo/Greeter'], 'the packaged class is loaded');

  const dotted = debug.setBreakpointAt('pkg.demo.Greeter.greet');
  t.equal(dotted.className, 'pkg/demo/Greeter', 'dotted package form resolves');

  const slashed = debug.setBreakpointAt('pkg/demo/Greeter.greet');
  t.equal(slashed.className, 'pkg/demo/Greeter', 'slashed internal form resolves');

  const overload = debug.setBreakpointAt('pkg.demo.Greeter.twice(int)');
  t.equal(overload.descriptor, '(I)I', 'signature selection works across packages');
  t.end();
});

test('a breakpoint on a not-yet-loaded class is deferred, then armed', async (t) => {
  const debug = controller();
  await debug.start('PackageMain', { args: [] });

  t.notOk(debug.jvm.classes['pkg/demo/Greeter'],
    'the class is genuinely not loaded yet (loading is lazy)');

  const result = debug.setBreakpointAt('pkg.demo.Greeter.greet');
  t.equal(result.status, 'breakpoint_pending', 'the request is kept, not rejected');
  t.deepEqual(debug.getPendingBreakpoints(), ['pkg.demo.Greeter.greet'],
    'listed as pending');

  await debug.continue();

  const state = debug.getCurrentState();
  t.equal(state.executionState, 'paused', 'execution stopped');
  t.equal(state.className, 'pkg/demo/Greeter', 'stopped in the packaged class');
  t.equal(state.method.name, 'greet', 'stopped in the deferred method');
  t.deepEqual(debug.getPendingBreakpoints(), [],
    'no longer pending once armed');
  t.end();
});

test('a typo in a loaded class is still an error, not a pending breakpoint',
  async (t) => {
    const debug = controller();
    await debug.start('SimpleArithmetic', { args: [] });
    t.throws(() => debug.setBreakpointAt('SimpleArithmetic.nosuch'), /No method/,
      'a missing method in a loaded class fails immediately');
    t.deepEqual(debug.getPendingBreakpoints(), [], 'nothing was deferred');
    t.end();
  });

test('a conditional breakpoint runs past its location until the condition holds',
  async (t) => {
    const debug = controller();
    await debug.start('WarmMain', { args: [] });

    // Work.tick(i) accumulates into Work.total over 300000 iterations.
    const set = debug.setBreakpointAt('Work.tick(int) if Work.total > 1000');
    t.equal(set.condition, 'Work.total > 1000', 'the condition is recorded');

    await debug.continue();

    const state = debug.getCurrentState();
    const total = debug.jvm.classes.Work.staticFields.get('total:I');
    t.equal(state.executionState, 'paused', 'stopped somewhere');
    t.equal(state.method.name, 'tick', 'stopped at the requested location');
    t.ok(total > 1000, `stopped only once the condition held (total=${total})`);
    t.ok(total < 20000,
      `stopped at the first passing hit, not much later (total=${total})`);
    t.end();
  });

test('a condition that never holds does not stop at all', async (t) => {
  const debug = controller();
  await debug.start('WarmMain', { args: [] });
  // Halt.stop runs once, so this checks the semantics without paying for
  // 300000 condition evaluations.
  debug.setBreakpointAt('Halt.stop if 1 == 2');
  await debug.continue();
  t.equal(debug.getCurrentState().executionState, 'stopped',
    'the program ran to completion through an always-false condition');
  t.end();
});

test('an unconditional breakpoint is unaffected by the condition machinery',
  async (t) => {
    const debug = controller();
    await debug.start('WarmMain', { args: [] });
    debug.setBreakpointAt('Work.tick(int)');
    await debug.continue();
    const total = debug.jvm.classes.Work.staticFields.get('total:I');
    t.equal(debug.getCurrentState().method.name, 'tick', 'stopped at tick');
    t.equal(total, 0, 'stopped on the very first hit');
    t.end();
  });

test('a condition that cannot be evaluated stops rather than being skipped',
  async (t) => {
    const debug = controller();
    await debug.start('WarmMain', { args: [] });
    debug.setBreakpointAt('Halt.stop if !!!nonsense!!!');
    const result = await debug.continue();
    t.equal(debug.getCurrentState().executionState, 'paused',
      'execution stopped instead of silently running past the breakpoint');
    t.ok(result.conditionError, 'the evaluation failure is reported: ' +
      String(result.conditionError).slice(0, 60));
    t.end();
  });

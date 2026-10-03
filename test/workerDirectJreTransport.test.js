const test = require('tape');
const {JVM} = require('../src/core/jvm');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const compileFixture = makeJavaFixtureCompiler('worker-direct-jre-');

test('worker transports protected static intrinsics and observes native replacement', async t => {
  const classpath = compileFixture(t, 'ProtectedMath', `
public class ProtectedMath {
  static int score(int x) {
    try { return (int)Math.pow(2.0, x); }
    catch (RuntimeException e) { return -1; }
  }
  public static void main(String[] args) { System.out.println(score(5)); }
}`);
  const jvm = new JVM({classpath, prepareBeforeMain: false, jit: {
    compileWorker: true, structuredSsa: true, preferWholeMethodJs: true,
    retainCompilerDiagnostics: false, warmupThreshold: 0,
  }});
  jvm.jre = {...jvm.jre,
    'java/lang/Math': {...jvm.jre['java/lang/Math'], methods: {...jvm.jre['java/lang/Math'].methods}},
    'java/io/PrintStream': {...jvm.jre['java/io/PrintStream'], methods: {...jvm.jre['java/io/PrintStream'].methods}},
  };
  t.teardown(() => jvm.jit.compileWorker.dispose());
  await jvm.preloadClasspathClasses();
  await jvm.preloadReferencedClasses();
  const method = await jvm.findMethodInHierarchy('ProtectedMath', 'score', '(I)I');
  t.ok(jvm.jit.compileWorker.enqueue(method), 'worker accepts protected call');
  await jvm.jit.compileWorker.whenIdle();
  const body = jvm.jit.codegenCache.get(method);
  t.ok(body, 'worker installs body');
  t.ok(body?.jvmRestoringDirectPositionalBody, 'protected intrinsic keeps restoring direct entry');
  t.equal(jvm.jit.compileWorker.stats.refused, 0, 'no transport refusal');
  t.ok([...jvm.jit.directJreDescriptors.values()].some(d => d.methodName === 'pow'),
    'receiver binds a symbolic Math descriptor');
  let output = '';
  jvm.registerJreMethods({'java/io/PrintStream': {
    'println(I)V': (_jvm, _receiver, args) => { output += args[0] + ','; },
  }});
  await jvm.run('ProtectedMath');
  t.equal(output, '32,', 'cold initialization and intrinsic return preserve result');
  let calls = 0;
  jvm.registerJreOverrides({'java/lang/Math': {methods: {
    'pow(DD)D': () => { calls++; throw {type: 'java/lang/RuntimeException'}; },
  }}});
  await jvm.run('ProtectedMath');
  t.equal(output, '32,-1,', 'replacement exception reaches the Java handler');
  t.equal(calls, 1, 'fallback invokes replaced native exactly once');
  t.end();
});

test('direct native transport rejects missing and conflicting receiver bindings', t => {
  const jvm = new JVM({jit: {compileWorker: false}});
  const jit = jvm.jit;
  const entry = {index: 0, className: 'java/lang/Math', methodName: 'sqrt',
    descriptor: '(D)D', isStatic: true, fieldWriteKeys: []};
  const place = value => jit.placeSiteTables({directJreIntrinsics: [value]});
  t.equal(place(entry), null, 'declared static intrinsic resolves');
  const original = jit.directJreIntrinsics[0];
  t.equal(original(9), 3, 'receiver binds executable local intrinsic');
  t.deepEqual(jit.describeSiteTablesSince({directJreIntrinsics: 0}).directJreIntrinsics[0], entry,
    'receiver preserves the descriptor for subsequent transport');
  t.match(place({...entry, methodName: 'cos'}), /occupied/, 'another intrinsic cannot overwrite a live slot');
  t.equal(jit.directJreIntrinsics[0], original, 'conflict preserves existing executable body');
  t.match(place({...entry, index: 1, methodName: 'missing'}), /does not resolve/, 'unknown native refuses installation');
  t.match(place({...entry, index: 1, isStatic: false}), /does not resolve/, 'instance descriptor refuses installation');
  t.match(place({...entry, index: 1, fieldWriteKeys: ['unexpected']}), /does not resolve/,
    'different native field effects refuse installation');
  t.end();
});

test('installed native guards avoid repeated resolution but observe JRE and JNI changes', t => {
  const jvm = new JVM({jit: {compileWorker: false}});
  const owner = jvm.jre['java/lang/Math'];
  jvm.jre = {...jvm.jre, 'java/lang/Math': {...owner, methods: {...owner.methods}}};
  const entry = {index: 0, className: 'java/lang/Math', methodName: 'sqrt',
    descriptor: '(D)D', isStatic: true, fieldWriteKeys: []};
  t.equal(jvm.jit.placeSiteTables({directJreIntrinsics: [entry]}), null, 'binding installs');
  const guard = jvm.jit.directJreInitializationTokens[0];
  t.notOk(guard.initialized, 'cold class retains initialization fallback');
  jvm._setClassInitializationState('java/lang/Math', 'INITIALIZED');
  let resolutions = 0;
  const resolve = jvm._jreFindMethod;
  jvm._jreFindMethod = function(...args) { resolutions++; return resolve.apply(this, args); };
  let allReady = true;
  for (let i = 0; i < 1000; i++) allReady = guard.initialized && allReady;
  t.ok(allReady, 'stable initialized binding stays usable');
  t.equal(resolutions, 0, 'hot checks do not repeat native resolution');
  jvm.registerNativeMethod('Unrelated', 'method', '()V', () => {});
  t.ok(guard.initialized, 'unrelated JNI registration preserves the intrinsic');
  t.equal(resolutions, 1, 'changed registry is resolved once');
  t.ok(guard.initialized, 'resolved binding stays usable');
  t.equal(resolutions, 1, 'unchanged registry is not resolved again');
  jvm.jre['java/lang/Math'].methods['sqrt(D)D'] = () => 17;
  t.notOk(guard.initialized, 'direct JRE slot replacement is observed');
  delete jvm.jre['java/lang/Math'].methods['sqrt(D)D'];
  t.ok(guard.initialized, 'restoring the declared slot restores its binding');
  jvm.registerNativeMethod('java/lang/Math', 'sqrt', '(D)D', () => 19);
  t.notOk(guard.initialized, 'JNI override falls back to canonical invocation');
  t.end();
});

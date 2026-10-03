'use strict';
const test = require('tape');
const { JVM } = require('../src/core/jvm');
const { makeJavaFixtureCompiler } = require('./javaFixture');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');
const { structuredWrappers } = require('../src/jit/JvmSsaBlockRenderer');
const compileFixture = makeJavaFixtureCompiler('shared-adaptive-');

test('ordinary adaptive canonical entries build and transport only one execution body', async t => {
  const classpath = compileFixture(t, 'SharedAdaptive', `public class SharedAdaptive {
    static int sum(int[] values, int n) { int s=0; for(int i=0;i<n;i++) s+=values[i]; return s; }
  }`);
  const jvm = new JVM({ classpath, jit: { compileWorker: false, structuredSsa: true,
    fuseStructuredResumeDispatch: true, ordinaryAdaptiveFramelessPositional: true } });
  await jvm.loadClassByName('SharedAdaptive');
  jvm.classInitializationState.set('SharedAdaptive', 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy('SharedAdaptive', 'sum', '([II)I');
  const tiers = [], create = jvm.jit.createGeneratedFunction;
  jvm.jit.createGeneratedFunction = function (...args) { tiers.push(args[1]); return create.apply(this,args); };
  const body = jvm.jit.structuredSsa.compile(method);
  jvm.jit.createGeneratedFunction = create;
  t.ok(body?.jvmStructuredWrapperShape.ordinaryAdaptiveCanonical, 'fixture selects the ordinary canonical entry');
  t.equal(body.jvmStructuredFramedBody, body.jvmAdaptiveGeneratedBody, 'both entry roles share the execution body');
  t.notOk(tiers.includes('structured-ssa'), 'does not compile an unused canonical generator');
  const payload = jvm.jit.serializeGeneratedResult(body);
  t.equal(payload.bodies.framed, null, 'no duplicate framed source crosses the worker boundary');
  t.ok(payload.shape.framedUsesAdaptive, 'transport explicitly describes the shared body');
  t.notOk(Object.hasOwn(payload.data, 'jvmStructuredWrapperShape'),
    'wrapper shape crosses only in its dedicated field');
  t.notOk(Object.hasOwn(payload.data, 'jvmStructuredSpeculation'),
    'speculation crosses only in its dedicated field');
  const rebound = jvm.jit.materializeGeneratedResult(structuredClone(payload), method);
  t.ok(rebound, 'shared result reconstructs');
  t.deepEqual(rebound.jvmStructuredWrapperShape, payload.shape,
    'receiver retains execution wrapper metadata');
  t.deepEqual(rebound.jvmStructuredSpeculation, payload.speculation,
    'receiver retains speculation guards');
  t.equal(rebound.jvmStructuredFramedBody, rebound.jvmAdaptiveGeneratedBody, 'receiver preserves body sharing');
  const retransmitted = jvm.jit.serializeGeneratedResult(rebound);
  t.equal(retransmitted.bodies.framed, null, 'retransport does not duplicate the shared body');
  t.ok(retransmitted.bodies.adaptive, 'retransport retains the executable body');
  const dispatched = jvm.jit.withResumeBody(body, method);
  t.ok(dispatched.jvmFusedStructuredResumeDispatch, 'local compile combines resume dispatch');
  const dispatchedRebound = jvm.jit.materializeGeneratedResult(
    structuredClone(jvm.jit.serializeGeneratedResult(dispatched)), method);
  t.ok(dispatchedRebound?.jvmFusedStructuredResumeDispatch, 'worker transport rebuilds combined dispatch');
  for (const entry of [body, rebound, dispatched, dispatchedRebound]) {
    const frame = new Frame(method); frame.className = 'SharedAdaptive';
    frame.locals.splice(0,2,[3,5,-2],3);
    const thread = {status:'runnable',callStack:new Stack()}; thread.callStack.push(frame);
    jvm._nextEventLoopYieldAt = Infinity;
    t.equal(entry(frame,thread,jvm.jit,false).value,6,'sum is exact');
    t.equal(thread.callStack.size(),0,'return retires the frame');
  }
  for (const key of ['ordinaryAdaptive','ordinaryAdaptiveCanonical','useContinuations']) {
    const invalid = structuredClone(payload); invalid.shape[key] = false;
    t.equal(jvm.jit.materializeGeneratedResult(invalid, method), null, `rejects invalid shared-body shape: ${key}`);
  }
  const plain = Object.assign(function () { return 7; }, {
    jvmGeneratedSource: 'return 7;', jvmParameters: [],
    jvmStructuredWrapperShape: {plainMetadata: true},
    jvmStructuredSpeculation: {plainGuard: true},
  });
  const plainPayload = jvm.jit.serializeGeneratedResult(plain);
  const plainRebound = jvm.jit.materializeGeneratedResult(plainPayload, method);
  t.deepEqual(plainRebound.jvmStructuredWrapperShape, plain.jvmStructuredWrapperShape,
    'plain entries keep metadata that has no dedicated reconstruction path');
  t.deepEqual(plainRebound.jvmStructuredSpeculation, plain.jvmStructuredSpeculation,
    'plain entries retain their speculation metadata');
  t.equal(plainRebound(), 7, 'plain entry still executes after transport');
  t.end();
});

for (const fused of [false,true]) test('replacement adaptive body resumes an older iterator (fused=' + fused + ')', t => {
  const state = { guardedStaticBooleanStateMatches: () => true,
    fieldBackedArrayStateMatches: () => true, captureFieldBackedArrayState: () => null };
  const frame = {pc:0,stack:{itemCount:0}}, thread = {callStack:new Stack()}; thread.callStack.push(frame);
  let resumed = 0, adaptiveCalls = 0;
  const old = structuredWrappers.wrapFramedStructuredBody(function* () {
    yield {structuredResumePc:7}; resumed++;
    thread.callStack.pop(); return {returned:true,value:41};
  }, state, {itemCount:20,ordinaryAdaptiveCanonical:false});
  const helpers = { needsBytecodeChecks:()=>false };
  old(frame,thread,helpers,false); frame.pc=7;
  const adaptive = () => { adaptiveCalls++; return {returned:true,value:99}; };
  let replacement = structuredWrappers.wrapFramedStructuredBody(adaptive,state,
    {itemCount:20,ordinaryAdaptiveCanonical:true,adaptivePositionalBody:adaptive});
  if (fused) {
    replacement.jvmStructuredWrapperShape={useContinuations:true,ordinaryAdaptive:true,ordinaryAdaptiveCanonical:true};
    replacement.jvmAdaptivePositionalBody=adaptive;
    structuredWrappers.attachStructuredContinuationHelpers(replacement,adaptive);
    replacement=new JVM({jit:{compileWorker:false,fuseStructuredResumeDispatch:true}}).jit.buildResumeDispatcher(
      replacement,()=>{throw new Error('unexpected baseline entry');},{});
    t.ok(replacement.jvmFusedStructuredResumeDispatch,'replacement selects combined dispatch');
  }
  t.equal(replacement(frame,thread,helpers,false).value,41,'stored iterator completes instead of restarting the method');
  t.equal(resumed,1,'old iterator resumes exactly once');
  t.equal(adaptiveCalls,0,'replacement body did not replay guest work');
  t.end();
});

test('a real compile worker installs a shared adaptive execution body', async t => {
  const classpath = compileFixture(t, 'SharedAdaptiveWorker', `public class SharedAdaptiveWorker {
    public static int sum(int[] values, int n) { int s=0; for(int i=0;i<n;i++) s+=values[i]; return s; }
  }`);
  const jvm = new JVM({classpath, prepareBeforeMain:false, jit:{compileWorker:true,
    structuredSsa:true, warmupThreshold:0, fuseStructuredResumeDispatch:true, ordinaryAdaptiveFramelessPositional:true}});
  const jit = jvm.jit;
  t.teardown(() => jit.compileWorker.dispose());
  await jvm.loadClassByName('SharedAdaptiveWorker');
  jvm.classInitializationState.set('SharedAdaptiveWorker', 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy('SharedAdaptiveWorker', 'sum', '([II)I');
  jvm.guestStarted = true;
  jit.markMainStarted();
  jit.getGeneratedFunction(method);
  await jit.compileWorker.whenIdle();
  t.ok(jit.compileWorker.installedMethods.has(method), 'worker installs the method');
  const installed = jit.codegenCache.get(method);
  t.ok(installed?.jvmFusedStructuredResumeDispatch, 'real worker installation combines dispatch');
  const body = installed?.jvmFastBody || installed;
  t.ok(body?.jvmStructuredWrapperShape?.framedUsesAdaptive, 'worker uses the shared-body protocol');
  t.equal(body?.jvmStructuredFramedBody, body?.jvmAdaptiveGeneratedBody, 'installed entry roles share one function');
  const frame = new Frame(method); frame.className = 'SharedAdaptiveWorker';
  frame.locals.splice(0,2,[3,5,-2],3);
  const thread = {status:'runnable',callStack:new Stack()}; thread.callStack.push(frame);
  jvm._nextEventLoopYieldAt = Infinity;
  t.equal(installed(frame,thread,jit,false).value,6,'worker-built method returns the exact sum');
  t.equal(thread.callStack.size(),0,'worker-built method retires its frame');
  t.end();
});

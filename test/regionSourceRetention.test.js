'use strict';
const test = require('tape');
const {JVM} = require('../src/core/jvm');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const Stack = require('../src/core/stack');
const Frame = require('../src/core/frame');
const compileFixture = makeJavaFixtureCompiler('region-source-retention-');

test('region budget exhaustion releases raw and wrapped source while execution survives', async t => {
  const classpath = compileFixture(t, 'RegionRetention', `public class RegionRetention {
    static int leaf(int value, boolean bias) { return value * 3 + (bias ? 1 : 2); }
    static int root(int rounds) { int sum=0; for(int i=0;i<rounds;i++) sum+=leaf(i,(i&1)!=0); return sum; }
  }`);
  const jvm = new JVM({classpath,jit:{compileWorker:false,structuredSsa:true,
    hotCallGraphRegions:true,hotCallGraphDirectSafePointBudget:32,profileMethods:false}});
  const jit = jvm.jit;
  await jvm.loadClassByName('RegionRetention');
  jvm.classInitializationState.set('RegionRetention','INITIALIZED');
  const leaf = await jvm.findMethodInHierarchy('RegionRetention','leaf','(IZ)I');
  const root = await jvm.findMethodInHierarchy('RegionRetention','root','(I)I');
  jit.getGeneratedFunction(leaf);jit.getGeneratedFunction(root);
  const charged = jit.installedSourceRetention.bytes;
  jit.installedSourceRetention.limit = charged;
  jit.hotCallGraphRegions.traceSource = true;
  jit.hotCallGraphRegions.traceDeopts = true;
  const rawBodies=[],create=jit.createGeneratedFunction;
  jit.createGeneratedFunction=function(...args){
    const body=create.apply(this,args);
    if(args[1].startsWith('hot-call-graph'))rawBodies.push(body);
    return body;
  };
  const plan=jit.compileHotCallGraphRegion(root);
  jit.createGeneratedFunction=create;
  t.ok(plan?.backendEligible,'fixture compiles a linked region');
  t.ok(rawBodies.length>=2,'both entry shapes construct executable modules');
  for(const body of [...rawBodies,plan.positionalBody,plan.framedBody]) {
    t.equal(body?.jvmGeneratedSource,undefined,'generated source is released');
    t.equal(body?.jvmHoistedSource,undefined,'factory source is released');
    t.equal(body?.jvmHotCallGraphRegionSource,undefined,'module-source alias is released');
  }
  t.equal(plan.summary.source,undefined,'diagnostic summary does not retain a second source reference');
  t.ok(plan.summary.sourceBytes>0,'compiled size remains observable after source release');
  t.equal(jit.installedSourceRetention.bytes,charged,'exhausted budget does not increase');
  const thread={status:'runnable',callStack:new Stack()};
  jvm._nextEventLoopYieldAt=Infinity;
  t.equal(plan.positionalBody(jit,10,thread),150,'linked executable survives source cleanup');
  t.equal(jit.compileHotCallGraphRegion(root),plan,'cached region remains usable');
  const frame=new Frame(root);frame.className='RegionRetention';frame.locals[0]=100;
  thread.callStack.push(frame);
  jvm._nextEventLoopYieldAt=-1;
  const yielded=plan.framedBody(frame,thread,jit,false);
  t.ok(yielded?.deopt,'an expired deadline suspends the cleaned framed module');
  t.ok(plan.root.generated.jvmHotCallGraphHasContinuation(frame),'suspension retains its iterator');
  jvm._nextEventLoopYieldAt=Infinity;
  const completed=plan.framedBody(frame,thread,jit,false);
  t.equal(completed?.value,15000,'the cleaned module resumes to the exact result');
  t.equal(thread.callStack.size(),0,'resumed return retires the frame');
  t.end();
});

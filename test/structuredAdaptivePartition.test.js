'use strict';
const test = require('tape');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const {JVM} = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');
const compileFixture = makeJavaFixtureCompiler('adaptive-partition-');

for (const [explicitFrameSpills, sharedMaterializer] of [[false,false],[true,false],[false,true]]) test(`partitioned adaptive entries preserve execution and worker transport (explicit spills ${explicitFrameSpills}, shared materializer ${sharedMaterializer})`, async t => {
  const operations = Array.from({length: 80}, (_, k) =>
    `s = (s * 31) ^ a[(i + ${k}) & 7];`).join('\n');
  const classpath = compileFixture(t, 'AdaptivePartition', `
public class AdaptivePartition {
  public static int run(int[] a, int n, int s) {
    for (int i=0; i<n; i++) { ${operations} }
    return s;
  }
}`);
  const jvm = new JVM({classpath, jit: {compileWorker: false, structuredSsa: true, structuredExplicitFrameSpills: explicitFrameSpills, structuredSharedFramedMaterializer: sharedMaterializer,
    ordinaryAdaptiveFramelessPositional: true, structuredLinearPartition: true,
    structuredLinearPartitionUnitBytes: 16384,
    structuredLinearPartitionSegmentBytes: 4096,
    structuredLinearPartitionMinimumSegmentBytes: 1024}});
  await jvm.loadClassByName('AdaptivePartition');
  jvm.classInitializationState.set('AdaptivePartition', 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy('AdaptivePartition', 'run', '([III)I');
  const generated = jvm.jit.structuredSsa.compile(method);
  t.ok(generated, `compiled: ${jvm.jit.structuredSsa.lastRejectionReason}`);
  if (!generated) {t.end();return;}
  t.ok(generated.jvmAdaptivePositionalOrdinary, 'ordinary adaptive entry is selected');
  if (sharedMaterializer) t.ok(generated.toString().includes('ssaMaterializeShared'), 'shared materializer is emitted');
  t.ok(generated.jvmAdaptivePartitionedSegmentCount > 0, 'the adaptive entry is actually split');
  const rebound = jvm.jit.materializeGeneratedResult(jvm.jit.serializeGeneratedResult(generated), method);
  t.ok(rebound, 'split helpers survive worker transport');
  jvm.jit.structuredSsa.linearPartitionEnabled = false;
  jvm.jit.structuredSsa.explicitFrameSpills = false;
  jvm.jit.structuredSsa.sharedFramedMaterializer = false;
  const control = jvm.jit.structuredSsa.compile(method);
  t.equal(control.jvmAdaptivePartitionedSegmentCount, 0, 'control uses the unsplit entry');
  for (const body of [generated, rebound]) {
    for (const n of [0, 1, 3]) {
      const array = [3, -7, 11, 0, 9, -20, 15, 100];array.type='[I';
      let expected=17;for(let i=0;i<n;i++)for(let k=0;k<80;k++)expected=(Math.imul(expected,31)^array[(i+k)&7])|0;
      const frame=new Frame(method);frame.className='AdaptivePartition';
      frame.locals.splice(0,3,array,n,17);
      const thread={status:'runnable',callStack:new Stack()};thread.callStack.push(frame);
      jvm._nextEventLoopYieldAt=Infinity;
      const result=body(frame,thread,jvm.jit,false);
      t.equal(result.value,expected,`exact result for ${n} iterations`);
      t.equal(thread.callStack.size(),0,'normal return retires the frame');
    }
  }
  const observe = (body, array, n, deadline) => {
    const frame = new Frame(method); frame.className = 'AdaptivePartition';
    frame.locals.splice(0, 3, array, n, 17);
    const thread = {status: 'runnable', callStack: new Stack()}; thread.callStack.push(frame);
    jvm._nextEventLoopYieldAt = deadline;
    let outcome;
    try { outcome = body(frame, thread, jvm.jit, false); }
    catch (error) { outcome = {error: error.type, message: error.message}; }
    return {outcome, pc: frame.pc, locals: frame.locals, stack: frame.stack.items,
      depth: thread.callStack.size()};
  };
  for (const [array, n, deadline, label] of [
    [null, 0, Infinity, 'unused null array'],
    [null, 1, Infinity, 'null array exception'],
    [[1, 2, 3], 1, Infinity, 'bounds exception after earlier arithmetic'],
    [[1, 2, 3, 4, 5, 6, 7, 8], 10000, 0, 'scheduler suspension'],
  ]) {
    const expected = observe(control, array, n, deadline);
    if (label === 'scheduler suspension') t.ok(expected.outcome.deopt, 'control reaches a safe point');
    for (const body of [generated, rebound]) {
      t.deepEqual(observe(body, array, n, deadline), expected,
        `${label}: exact result, PC, locals, operands and frame depth`);
    }
  }
  t.end();
});

for (const [explicitFrameSpills, sharedMaterializer] of [[false,false],[true,false],[false,true]]) test(`adaptive partitions preserve the per-call fast-path guard binding (explicit spills ${explicitFrameSpills}, shared materializer ${sharedMaterializer})`, async t => {
  const calls = Array.from({length: 40}, (_, i) => `s = child(s) + ${i};`).join('\n');
  const classpath = compileFixture(t, 'PartitionCalls', `
public class PartitionCalls {
  static int seen;
  public static int child(int v) { seen++; return v + 1; }
  public static int run(int n, int s) { for (int i=0; i<n; i++) { ${calls} } return s; }
}`);
  const jvm = new JVM({classpath, jit: {compileWorker: false, structuredSsa: true, structuredExplicitFrameSpills: explicitFrameSpills, structuredSharedFramedMaterializer: sharedMaterializer,
    ordinaryAdaptiveFramelessPositional: true, compiledCallChains: true,
    ordinaryAdaptiveCallChainSafePointBudget: 10000, structuredLinearPartition: true,
    structuredLinearPartitionUnitBytes: 16384,
    structuredLinearPartitionSegmentBytes: 4096,
    structuredLinearPartitionMinimumSegmentBytes: 1024}});
  await jvm.loadClassByName('PartitionCalls');
  jvm.classInitializationState.set('PartitionCalls', 'INITIALIZED');
  jvm.classes.PartitionCalls.staticFields.set('seen:I', 0);
  const child = await jvm.findMethodInHierarchy('PartitionCalls', 'child', '(I)I');
  jvm.jit.codegenCache.set(child, jvm.jit.structuredSsa.compile(child));
  const method = await jvm.findMethodInHierarchy('PartitionCalls', 'run', '(II)I');
  jvm.jit.preparedCodegenMethods.add(method);
  const generated = jvm.jit.structuredSsa.compile(method);
  t.ok(generated, `compiled: ${jvm.jit.structuredSsa.lastRejectionReason}`);
  if (!generated) { t.end(); return; }
  t.ok(generated.jvmAdaptivePartitionedSegmentCount > 0, 'adaptive call body actually partitions');
  const rebound = jvm.jit.materializeGeneratedResult(jvm.jit.serializeGeneratedResult(generated), method);
  for (const body of [generated, rebound]) {
    const frame = new Frame(method); frame.className = 'PartitionCalls';
    frame.locals.splice(0, 2, 1, 17);
    const thread = {status: 'runnable', callStack: new Stack()}; thread.callStack.push(frame);
    jvm._nextEventLoopYieldAt = Infinity;
    let result, error;
    try { result = body(frame, thread, jvm.jit, false); } catch (caught) { error = caught; }
    t.notOk(error, `guard binding survives extracted prologue: ${error?.message}`);
    t.equal(result?.value, 837, 'all child calls complete normally');
  }
  t.end();
});

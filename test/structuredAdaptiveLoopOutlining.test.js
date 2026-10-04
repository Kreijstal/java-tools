'use strict';
const test = require('tape');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const {JVM} = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');
const compileFixture = makeJavaFixtureCompiler('adaptive-loop-outline-');

for (const [explicitFrameSpills, sharedMaterializer] of [[true,false]]) test(`outlined adaptive entries preserve execution and worker transport (explicit spills ${explicitFrameSpills}, shared materializer ${sharedMaterializer})`, async t => {
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
    ordinaryAdaptiveFramelessPositional: true, structuredLoopOutlining: true, structuredLoopOutlineSourceBytes: 4096, structuredCompactFieldCacheInvalidation: false,
}});
  await jvm.loadClassByName('AdaptivePartition');
  jvm.classInitializationState.set('AdaptivePartition', 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy('AdaptivePartition', 'run', '([III)I');
  const generated = jvm.jit.structuredSsa.compile(method);
  t.ok(generated, `compiled: ${jvm.jit.structuredSsa.lastRejectionReason}`);
  if (!generated) {t.end();return;}
  t.ok(generated.jvmAdaptivePositionalOrdinary, 'ordinary adaptive entry is selected');
  if (sharedMaterializer) t.ok(generated.toString().includes('ssaMaterializeShared'), 'shared materializer is emitted');
  t.ok(generated.jvmAdaptiveOutlinedLoopCount > 0, 'the adaptive loop is actually outlined');
  const rebound = jvm.jit.materializeGeneratedResult(jvm.jit.serializeGeneratedResult(generated), method);
  t.ok(rebound, 'outlined helpers survive worker transport');
  for (const body of [generated, rebound]) {
    t.ok(body.jvmAdaptivePositionalBody.jvmHoistedSource.includes('function jvmRegionOutlinedLoop'),
      'parameter-complete loop helper lives in the factory');
    t.notOk(String(body.jvmAdaptivePositionalBody).includes('function jvmRegionOutlinedLoop'),
      'hot entry does not allocate the loop helper');
  }
  jvm.jit.structuredSsa.loopOutliningEnabled = false;
  jvm.jit.structuredSsa.explicitFrameSpills = false;
  jvm.jit.structuredSsa.sharedFramedMaterializer = false;
  const control = jvm.jit.structuredSsa.compile(method);
  t.equal(control.jvmAdaptiveOutlinedLoopCount, 0, 'control uses the original loop');
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

for (const [explicitFrameSpills, sharedMaterializer] of [[true,false]]) test(`adaptive loop outlines preserve the per-call fast-path guard binding (explicit spills ${explicitFrameSpills}, shared materializer ${sharedMaterializer})`, async t => {
  const calls = Array.from({length: 40}, (_, i) => `s = child(s) + ${i};`).join('\n');
  const classpath = compileFixture(t, 'PartitionCalls', `
public class PartitionCalls {
  static int seen;
  public static int child(int v) { seen++; return v + 1; }
  public static int run(int n, int s) { for (int i=0; i<n; i++) { ${calls} } return s; }
}`);
  const jvm = new JVM({classpath, jit: {compileWorker: false, structuredSsa: true, structuredExplicitFrameSpills: explicitFrameSpills, structuredSharedFramedMaterializer: sharedMaterializer,
    ordinaryAdaptiveFramelessPositional: true, compiledCallChains: true,
    ordinaryAdaptiveCallChainSafePointBudget: 10000, structuredLoopOutlining: true, structuredLoopOutlineSourceBytes: 4096, structuredCompactFieldCacheInvalidation: false,
}});
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
  t.ok(generated.jvmAdaptiveOutlinedLoopCount > 0, 'adaptive call loop is actually outlined');
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


test('outlined loops omit unused writebacks only with complete outside reads', t => {
  const {outlineLargeRegionLoops, regionUnit, renderRegionUnit, ownStatement} =
    require('../src/jit/HotCallGraphRegionCompiler');
  for (const opaqueOutside of [false, true]) {
    const unit = regionUnit({statements: [
      ownStatement('let scratch = 0;', {def: 'scratch'}),
      ownStatement('let kept = 1;', {def: 'kept'}),
      ownStatement('for (let i = 0; i < 3; i++) {',
        {def: 'i', reads: ['i'], delta: 1, opens: 'loop'}),
      ownStatement('scratch += i;', {reads: ['scratch', 'i'], write: 'scratch'}),
      ownStatement('kept += scratch;', {reads: ['kept', 'scratch'], write: 'kept'}),
      ownStatement('/*' + 'padding '.repeat(100) + '*/'),
      ownStatement('}', {delta: -1}),
      ...(opaqueOutside ? [ownStatement('void scratch;', {reads: null})] : []),
      ownStatement('return kept;', {reads: ['kept'],
        exit: {before: [], value: ['kept'], after: []}}),
    ]});
    const outlined = outlineLargeRegionLoops(unit,
      {minimumSourceBytes: 512, pruneUnusedLiveOuts: true});
    t.equal(outlined.count, 1, 'loop is actually extracted');
    const source = [outlined.unit, ...outlined.helpers].map(renderRegionUnit).join('\n');
    const run = new Function(source);
    t.equal(run(), 5, 'observable value survives the loop boundary');
    t.equal(/\] = scratch;/.test(source), opaqueOutside,
      'unknown outside code retains scratch, complete reads omit its writeback');
  }
  t.end();
});

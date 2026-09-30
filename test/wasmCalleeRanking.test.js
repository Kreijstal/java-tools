'use strict';
const test = require('tape');
const {JVM} = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const {hasUncheckedSpeculation} = require('../src/jit/wasmShared');
const compile = require('./javaFixture').makeJavaFixtureCompiler('wasm-callee-ranking-');

test('callee selection prefers an eligible partial dispatcher over speculative primary', async t => {
  const classpath = compile(t, 'RankedCallee', `
public class RankedCallee {
  static int count;
  static native void cold();
  int value() { count++; return 7; }
  static int helper(RankedCallee receiver, int n) {
    if (n < 0) cold();
    int total = 0;
    for (int i = 0; i < n; i++) total += receiver.value();
    return total;
  }
}`);
  const j = new JVM({classpath, jit: {compileWorker: false, wasmStructured: true,
    wasm: {preferCompleteInstanceCallees:true}}});
  await j.preloadClasspathClasses();
  j._setClassInitializationState('RankedCallee', 'INITIALIZED');
  const w=j.jit.wasmJit;
  t.ok(w.preferCompleteInstanceCallees, 'configured instance preference is enabled');
  const leaf=await j.findMethodInHierarchy('RankedCallee','value','()I');
  w.compile({method:leaf,className:'RankedCallee'},w.methodState({method:leaf}),{asCallee:true});
  const method=await j.findMethodInHierarchy('RankedCallee','helper','(LRankedCallee;I)I');
  const state=w.methodState({method});
  w.compile({method,className:'RankedCallee'},state,{asCallee:true});
  t.equal(state.status,'ready',state.lastCompileError||'helper compiles');
  t.ok(hasUncheckedSpeculation(state.meta),'primary exercises a speculative inline');
  t.notOk(state.osr.meta.boxedCount,'dispatcher has unboxed slots');
  t.ok(state.osr.meta.externalEntry.has(0),'dispatcher admits canonical entry');
  t.notOk(hasUncheckedSpeculation(state.osr.meta),'dispatcher does not require entry speculation');
  t.equal(state.callee,state.osr,'callee uses eligible dispatcher');
  t.equal(w.findReadyStatic('RankedCallee','helper','(LRankedCallee;I)I',true),state,
    'static callers can discover the existing partial body');
  t.notOk(state.meta.fullyCompiled,'primary coverage is not relabelled');
  t.notOk(state.osr.meta.fullyCompiled,'unsupported cold branch remains a fallback');
  const meta=state.osr.meta,frame=new Frame(method),receiver={type:'RankedCallee',fields:{}};
  frame.className='RankedCallee';meta.box.frame=frame;
  const args=meta.paramSlots.map(({slot})=>slot===0?receiver:slot===1?6:0);
  t.equal(state.osr.run(...args,0,100000),-1,'valid dispatcher entry completes in Wasm');
  t.equal(meta.box.ret,42,'compiled calls produce the exact result');
  t.equal(j.classes.RankedCallee.staticFields.get('count:I'),6,'callee effects execute exactly once');
  meta.box.frame=new Frame(method);
  const coldArgs=meta.paramSlots.map(({slot})=>slot===0?receiver:slot===1?-1:0);
  const resume=state.osr.run(...coldArgs,0,100000);
  t.ok(resume>=0,'unsupported cold branch exits to canonical execution');
  t.equal(meta.box.frame.locals[0],receiver,'fallback retains receiver identity');
  t.equal(meta.box.frame.locals[1],-1,'fallback retains the argument');
  t.equal(j.classes.RankedCallee.staticFields.get('count:I'),6,'cold exit does not replay or run leaf effects');
  t.end();
});

test('instance bridges prefer complete guard-elided bodies and invalidate before effects', async t => {
  const classpath = compile(t, 'RankedVoice', `
public class RankedVoice {
  int calls, last;
  int value(int i) { calls++; last = i + 3; return last; }
  synchronized int fill(int n) {
    int total = 0;
    for (int i = 0; i < n; i++) total += value(i);
    return total;
  }
  static int drive(RankedVoice voice, int n) { return voice.fill(n); }
}
class LateVoice extends RankedVoice {
  int value(int i) { calls++; last = i + 100; return last; }
}`);
  const j = new JVM({classpath, jit: {compileWorker:false, wasmStructured:true,
    wasmSynchronizedInstanceLinks:true}});
  await j.loadClassByName('RankedVoice');
  j._setClassInitializationState('RankedVoice', 'INITIALIZED');
  const w = j.jit.wasmJit;
  w.noOnDemandCalleeCompile = true;
  const fill = await j.findMethodInHierarchy('RankedVoice', 'fill', '(I)I');
  const state = w.methodState({method:fill});
  w.compile({method:fill, className:'RankedVoice'}, state, {asCallee:true});
  t.equal(state.status, 'ready', state.lastCompileError || 'instance callee compiles');
  t.ok(state.meta.fullyCompiled, 'structured body has complete coverage');
  t.ok(state.meta.inlineSpecSites.length, 'this calls carry guard-elided assumptions');
  t.notOk(state.meta.speculations, 'no guarded inline exits require scheduler admission');
  t.notOk(state.osr.meta.normalFlowFullyCompiled, 'dispatcher control still exits at the unavailable helper');
  t.equal(w.preferCompleteInstanceCallees, false, 'alternative ranking is disabled by default');
  t.equal(state.callee, state.osr, 'default retains the conservative dispatcher choice');
  w.preferCompleteInstanceCallees = true;
  w.compile({method:fill, className:'RankedVoice'}, state, {asCallee:true});
  t.equal(state.callee, null, 'instance bridge selects the complete primary body');
  t.equal(w.findReadyInstance('RankedVoice', 'fill', '(I)I', true), state,
    'monitor-aware caller discovers the selected body');
  const method = await j.findMethodInHierarchy('RankedVoice', 'drive', '(LRankedVoice;I)I');
  const caller = w.methodState({method});
  w.compile({method, className:'RankedVoice'}, caller, {asCallee:true});
  t.equal(caller.status, 'ready', caller.lastCompileError || 'caller compiles');
  const CallStack = require('../src/core/callStack');
  const {makeObjectRef, newFields} = require('../src/core/objectModel');
  const voice = makeObjectRef(j, 'RankedVoice', newFields(j, 'RankedVoice'));
  const invoke = receiver => {
    const frame = new Frame(method); frame.className = 'RankedVoice';
    frame.locals[0] = receiver; frame.locals[1] = 4;
    const thread = {id:7, status:'runnable', callStack:new CallStack()};
    thread.callStack.push(frame);
    return {result:w.execute(frame, thread, caller, 0), frame, thread};
  };
  t.ok(invoke(voice).result.returned, 'the compiled chain returns without dispatcher exits');
  t.equal(caller.meta.box.ret, 18, 'compiled values are exact');
  t.equal(voice.fields['RankedVoice.calls'], 4, 'effects execute once per iteration');
  t.notOk(voice.isLocked, 'synchronized return releases the receiver');
  await j.loadClassByName('java/lang/Object');
  t.ok(w.revalidateNestedCallee(state), 'unrelated class growth keeps the module');
  await j.loadClassByName('LateVoice');
  const late = makeObjectRef(j, 'LateVoice', newFields(j, 'LateVoice'));
  const result = invoke(late);
  t.notOk(result.result.returned, 'overriding class growth falls back before the stale body');
  t.notEqual(state.status, 'ready', 'the captured inline assumptions are withdrawn');
  t.equal(late.fields['RankedVoice.calls'], 0, 'fallback has no stale callee effects');
  t.notOk(late.isLocked, 'invalidation precedes monitor acquisition');
  j._setClassInitializationState('LateVoice', 'INITIALIZED');
  j.threads = [result.thread]; j.currentThreadIndex = 0;
  let ticks = 0;
  while (result.thread.callStack.size() && ticks < 10000) {
    await j.executeTick(); ticks++;
  }
  t.equal(result.thread.callStack.size(), 0, 'the canonical fallback completes');
  t.equal(late.fields['RankedVoice.calls'], 4, 'fallback effects execute exactly once');
  t.equal(late.fields['RankedVoice.last'], 103, 'fallback dispatches the new override');
  t.notOk(late.isLocked, 'fallback retirement releases the monitor');
  t.end();
});

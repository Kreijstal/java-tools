'use strict';
const test = require('tape');
const {JVM} = require('../src/core/jvm');

test('resume dispatch preserves tier routing and call contracts', t => {
  const jit = new JVM({jit:{compileWorker:false}}).jit;
  const method = {className:'DispatchProbe',name:'run',descriptor:'()V'};
  const calls = [], fastResult = {}, resumeResult = {};
  const fast = (...args) => { calls.push({tier:'fast',args}); return fastResult; };
  const resume = (...args) => { calls.push({tier:'resume',args}); return resumeResult; };
  fast.jvmStructuredResumePcs = new Set([7]);
  fast.jvmHasStructuredContinuation = frame => frame.continuation === true;
  const dispatch = jit.buildResumeDispatcher(fast,resume,method);
  const thread = {}, helpers = {};
  for (const [pc,continuation,expected] of [[0,false,'fast'],[7,false,'fast'],[3,false,'resume'],[3,true,'fast']]) {
    const frame = {pc,continuation};
    const value = dispatch(frame,thread,helpers,true,true);
    t.equal(value,expected === 'fast' ? fastResult : resumeResult,`${pc}/${continuation}: preserves result identity`);
    const call = calls.pop();
    t.equal(call.tier,expected,`${pc}/${continuation}: selects the correct tier`);
    t.deepEqual(call.args,expected === 'fast' ? [frame,thread,helpers,true,true] : [frame,thread,helpers,true],
      `${pc}/${continuation}: preserves entry arguments`);
  }
  fast.jvmStructuredResumePcs.add(3);
  t.equal(dispatch({pc:3},thread,helpers,false),fastResult,'published resume entries are consulted live');
  const failure = new Error('guest exception');
  const throwing = jit.buildResumeDispatcher(() => {throw failure;},resume,method);
  try { throwing({pc:0},thread,helpers,false); t.fail('exception must escape'); }
  catch (error) { t.equal(error,failure,'guest exception identity survives the dispatcher'); }
  t.end();
});

test('combined canonical dispatch preserves live routing and diagnostic counting', t => {
  const {structuredWrappers: wrappers} = require('../src/jit/JvmSsaBlockRenderer');
  for (const enabled of [false,true]) for (const diagnostics of [false,true]) {
    const jit = new JVM({jit:{compileWorker:false,fuseStructuredResumeDispatch:enabled,
      profileResumeDispatch:diagnostics}}).jit;
    const calls=[], value={}, baseline={};
    const adaptive = (...args) => {calls.push(['adaptive',args]); return value;};
    const fast=wrappers.wrapFramedStructuredBody(null,{}, {
      ordinaryAdaptiveCanonical:true,adaptivePositionalBody:adaptive});
    fast.jvmStructuredWrapperShape={useContinuations:true,ordinaryAdaptive:true,ordinaryAdaptiveCanonical:true};
    fast.jvmAdaptivePositionalBody=adaptive;
    fast.jvmStructuredResumePcs=new Set([7]);
    wrappers.attachStructuredContinuationHelpers(fast,function* () {});
    const resume=(...args)=>{calls.push(['baseline',args]);return baseline;};
    const method={className:'DispatchProbe',name:'run',descriptor:'()V'};
    const dispatch=jit.buildResumeDispatcher(fast,resume,method);
    t.equal(dispatch.jvmFusedStructuredResumeDispatch,enabled&&!diagnostics,'profiling keeps diagnostic dispatcher');
    for (const pc of [0,7,3]) for (const checks of [undefined,false,true]) {
      const frame={pc},thread={},helpers={};
      const expected=pc===3?'baseline':'adaptive';
      t.equal(dispatch(frame,thread,helpers,checks,true),pc===3?baseline:value,'exact result identity');
      t.deepEqual(calls.pop(),[expected,pc===3?[frame,thread,helpers,checks]:[frame,thread,helpers,checks,false]],
        'canonical entry remains framed and forwards bytecode checks');
    }
    fast.jvmStructuredResumePcs=new Set([3]);
    t.equal(dispatch({pc:3},{},{},false),value,'replaced resume set is consulted live');
    if(diagnostics) {
      const row=jit.resumeDispatchStats.get('DispatchProbe.run()V');
      t.equal(row.fast,7,'fast entries counted');t.equal(row.resume,3,'baseline entries counted');
    }
  }
  t.end();
});

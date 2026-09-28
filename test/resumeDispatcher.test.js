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

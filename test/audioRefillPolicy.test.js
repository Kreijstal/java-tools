'use strict';
const test = require('tape');
const Policy = require('../src/core/AudioRefillPolicy');
const {JVM} = require('../src/core/jvm');
test('refill hints survive sleep and expire only with actual lifecycle changes', t => {
  let now = 0, queued = 0.01;
  const policy = new Policy(() => now);
  const producer = {id:1,status:'runnable'};
  const output = {queuedSeconds:()=>queued,context:{state:'running'},
    bufferSize:16384,bytesPerFrame:4,options:{sampleRate:22050}};
  policy.requested(producer,output);now=20;policy.completed(producer,output);
  t.equal(policy.select([producer]).thread,producer,'a depleted queue receives priority');
  producer.status='SLEEPING';now=200;
  t.equal(policy.select([producer]),null,'priority never wakes a sleeping Java thread');
  t.equal(policy.sources.size,1,'sleep does not discard producer knowledge');
  producer.status='runnable';
  t.equal(policy.select([producer]).thread,producer,'ordinary wakeup restores refill priority beyond 50 ms');
  queued=0.1;
  t.equal(policy.select([producer]),null,'a sufficiently filled queue yields priority');
  queued=0.01;output.context.state='suspended';
  t.equal(policy.select([producer]),null,'autoplay suspension cannot hoard CPU');
  output.context.state='running';output.closed=true;
  t.equal(policy.select([producer]),null,'closed output is retired');
  t.equal(policy.sources.size,0,'retired outputs are not retained');
  t.end();
});
test('refill urgency respects scheduler fairness and never changes byte availability', t => {
  const jvm = new JVM({audioRefillScheduling:true,jit:{compileWorker:false}});
  t.teardown(()=>jvm.jit.compileWorker.dispose());
  const audio={id:1,status:'runnable'},render={id:2,status:'runnable'};
  jvm.threads=[audio,render];jvm.currentThreadIndex=1;
  const output={queuedSeconds:()=>0.005,available:()=>123,context:{state:'running'}};
  jvm.audioRefillPolicy.completed(audio,output);
  let checked=false;
  jvm._schedulerStarvationRelief=thread=>{checked=thread===audio;return true;};
  jvm._prepareSchedulerTick();
  t.ok(checked,'audio selection passes through the existing fairness gate');
  t.equal(output.available(),123,'scheduling does not falsify available bytes');
  t.end();
});

test('multiple outputs compete by slack without selecting blocked or detached writers', t => {
  const policy=new Policy(()=>0);
  const a={id:1,status:'runnable'},b={id:2,status:'runnable'};
  const first={queuedSeconds:()=>0.025},second={queuedSeconds:()=>0.005};
  policy.completed(a,first);policy.completed(b,second);
  t.equal(policy.select([a,b]).thread,b,'smaller playback slack is selected');
  b.status='WAITING';
  t.equal(policy.select([a,b]).thread,a,'monitor/wait blocking is never bypassed');
  b.status='runnable';
  t.equal(policy.select([a]).thread,a,'a detached writer cannot be scheduled');
  t.equal(policy.sources.size,1,'detached source registration is reclaimed');
  a.status='terminated';
  t.equal(policy.select([a]),null,'terminated writers cannot retain priority');
  t.end();
});

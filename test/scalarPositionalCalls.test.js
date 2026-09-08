'use strict';
const test = require('tape');
const {JVM} = require('../src/core/jvm');
const Stack = require('../src/core/stack');

test('scalar static positional calls retain guards, live links and operands', t => {
  const j = new JVM({jit:{compileWorker:false,scalarPositionalCalls:true}});
  const h=j.jit, frame={stack:{items:[91,7,3]}}, thread={status:'runnable',callStack:new Stack()};
  thread.callStack.push(frame);
  let slow=0, checks=false, invalid=false;
  h.needsBytecodeChecks=()=>checks;
  j.debugManager.isClassJitDeopted=()=>invalid;
  h.tryInvokeSyncAt=()=>{slow++;return 123;};
  const site={id:0,op:'invokestatic',params:['int','int'],returnType:'int',
    initializationToken:{initialized:true},fastPositional:{lookupClass:'Fixture',
      invoke:(a,b,th)=>{t.equal(th,thread,'thread passed after arguments');return a+b;}}};
  h.syncCallSites[0]=site;
  t.equal(h.tryInvokeScalarStaticAt(0,frame,thread),10,'compiled result');
  t.deepEqual(frame.stack.items,[91],'only call arguments consumed');
  frame.stack.items=[91,7,3];
  site.fastPositional.invoke=(a,b)=>a-b;
  t.equal(h.tryInvokeScalarStaticAt(0,frame,thread),4,'replacement link observed');
  for(const reason of ['initialization','debug','profiling','invalidated','missing','arity']) {
    frame.stack.items=[91,7,3];
    const original=site.fastPositional;
    if(reason==='initialization')site.initializationToken.initialized=false;
    if(reason==='debug')checks=true;
    if(reason==='profiling')h.profileMethods=true;
    if(reason==='invalidated')invalid=true;
    if(reason==='missing')site.fastPositional=null;
    if(reason==='arity')site.params=new Array(9).fill('int');
    t.equal(h.tryInvokeScalarStaticAt(0,frame,thread),123,reason+' falls back');
    t.deepEqual(frame.stack.items,[91,7,3],reason+' preserves operands');
    site.fastPositional=original;site.params=['int','int'];
    site.initializationToken.initialized=true;checks=false;invalid=false;h.profileMethods=false;
  }
  t.equal(slow,6,'one fallback per refused call');
  site.fastPositional.invoke=()=>h.asyncInvokeSentinel();
  t.equal(h.tryInvokeScalarStaticAt(0,frame,thread),123,'callee refusal falls back');
  t.deepEqual(frame.stack.items,[91,7,3],'refusal preserves operands');
  const error={type:'java/lang/ArithmeticException'};
  site.fastPositional.invoke=()=>{throw error;};
  t.throws(()=>h.tryInvokeScalarStaticAt(0,frame,thread),e=>e===error,'exception identity preserved');
  t.deepEqual(frame.stack.items,[91,7,3],'throwing call retains invoke operands');
  const child={stack:{items:[42]},jitGeneratedReturnParent:frame};
  site.fastPositional.invoke=()=>{thread.callStack.push(child);return {deopt:true,jvmPositionalChild:child};};
  t.equal(h.tryInvokeScalarStaticAt(0,frame,thread).jvmPositionalChild,child,'suspension returns owned child');
  t.deepEqual(frame.stack.items,[91],'suspended call consumes arguments once');
  t.equal(thread.callStack.peek(),child,'child stays scheduler-visible');
  t.end();
});

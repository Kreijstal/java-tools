'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm');
const Stack=require('../src/core/stack');
const Renderer=require('../src/jit/JvmSsaBlockRenderer');

for(const outcome of ['cooperativeSuspension','callHandoff'])
for(const enabled of [false,true])test(`${outcome}: policy ${enabled}`,t=>{
 const j=new JVM({jit:{compileWorker:false,retainFramelessAfterSuspension:enabled}});
 const method={className:'SuspensionFixture',name:'compute',descriptor:'(I)I',flags:['static'],
   attributes:[{type:'code',code:{localsSize:'1',stackSize:'1',exceptionTable:[],codeItems:[]}}]};
 const generated=()=>{throw Error('Unexpected canonical entry');};
 generated.jvmSynchronous=true;
 let calls=0;
 generated.jvmAdaptivePositionalBody=frame=>{
   calls++;
   if(calls===1){frame.pc=17;frame.stack.items.push(91);
     return {deopt:true,transient:true,[outcome]:true,reason:'test scheduler handoff'};}
   return frame.locals[0]+1;
 };
 const target={method,lookupClass:method.className,generated,preferFrameless:true,freeFrame:null};
 const site={op:'invokestatic',params:['int'],returnType:'int',descriptor:'(I)I',
   initializationToken:{initialized:true}};
 const invoke=j.jit.getPositionalGeneratedInvoker(site,target);
 const thread={status:'runnable',callStack:new Stack()};
 const out=invoke(40,thread),suspended=out.jvmPositionalChild;
 t.equal(thread.callStack.peek(),suspended,'suspended child is restored to the scheduler stack');
 t.equal(suspended.pc,17,'the exact resume PC is retained');
 t.deepEqual(suspended.stack.items,[91],'live operands survive suspension');
 t.equal(target.freeFrame,null,'a suspended frame cannot be recycled');
 t.equal(target.preferFrameless,enabled,'new policy retains the fast call ABI only for suspension');
 t.equal(!!target.framelessRejected,!enabled,'legacy rejection is an explicit control');
 if(enabled){
   t.equal(invoke(50,thread),51,'a later invocation can use the optimized ABI');
   t.notEqual(target.freeFrame,suspended,'the new invocation never resets the suspended frame');
   t.equal(thread.callStack.peek(),suspended,'the earlier scheduler-owned child stays in place');
   t.deepEqual(suspended.stack.items,[91],'re-entry preserves the earlier invocation operands');
   t.equal(j.jit.cooperativeCallSuspensionCount,1,'suspension is observable separately from rejection');
 }
 t.end();
});

test('a transient optimization rejection is not a cooperative suspension',t=>{
 const j=new JVM({jit:{compileWorker:false,retainFramelessAfterSuspension:true}});
 const method={className:'GuardFixture',name:'compute',descriptor:'()I',flags:['static'],
   attributes:[{type:'code',code:{localsSize:'0',stackSize:'1',exceptionTable:[],codeItems:[]}}]};
 const generated=()=>({returned:true,value:7});generated.jvmSynchronous=true;
 generated.jvmAdaptivePositionalBody=()=>({deopt:true,transient:true,reason:'changed speculation'});
 const target={method,lookupClass:method.className,generated,preferFrameless:true};
 const invoke=j.jit.getPositionalGeneratedInvoker({op:'invokestatic',params:[],returnType:'int',
   descriptor:'()I',initializationToken:{initialized:true}},target);
 invoke({status:'runnable',callStack:new Stack()});
 t.equal(target.framelessRejected,true,'semantic rejection retains its fallback policy');
 t.equal(target.preferFrameless,false,'transient alone is not enough to retain the ABI');
 t.equal(j.jit.cooperativeCallSuspensionCount,0,'rejections are not counted as scheduler suspensions');
 t.end();
});

test('ordinary callee handoff preserves invoke operands and PC',t=>{
 const sentinel={},frame={locals:[11],stack:{items:[]}};
 let spills=0,skipped=null;
 const renderer=Object.create(Renderer.prototype);
 renderer.jit={asyncInvokeSentinel:()=>sentinel,skipJitOnce:f=>{skipped=f;},
   materialize:(f,locals,stack,pc)=>{f.pc=pc;}};
 const out=renderer.coldCallOrdinary(frame,{status:'runnable',callStack:{items:[]}},
   sentinel,0,7,'int',18,false,()=>{spills++;},[91,40],1);
 t.equal(out.callHandoff,true,'the producer explicitly identifies the ordinary-runtime handoff');
 t.equal(frame.pc,17,'the interpreter must execute the invoke, not its successor');
 t.deepEqual(frame.stack.items,[91,40],'below-call operands and arguments remain live');
 t.equal(spills,1,'locals are materialized once');
 t.equal(skipped,frame,'the immediate retry uses the ordinary runtime');
 t.end();
});

test('callee semantic deoptimization propagates without being relabeled',t=>{
 const failure={deopt:true,transient:true,reason:'invalidated assumption'};
 const frame={locals:[],stack:{items:[]}};
 const renderer=Object.create(Renderer.prototype);
 renderer.jit={asyncInvokeSentinel:()=>null,skipJitOnce:()=>{},
   linkStructuredCallChild:()=>false,materialize:(f,locals,stack,pc)=>{f.pc=pc;}};
 const out=renderer.coldCallOrdinary(frame,{status:'runnable',callStack:{items:[]}},
   failure,0,7,'int',18,false,()=>{},[40],0);
 t.equal(out,failure,'the exact failure object propagates');
 t.equal(out.callHandoff,undefined,'a failed guard is not relabeled as a normal handoff');
 t.equal(frame.pc,17,'fallback resumes at the invoke');
 t.end();
});

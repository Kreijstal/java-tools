'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm');
const Frame=require('../src/core/frame');
const Stack=require('../src/core/stack');
const {parseMethodDescriptor,supportsWasmJsTag}=require('../src/jit/wasmShared');
const compile=require('./javaFixture').makeJavaFixtureCompiler('dispatcher-canonical-');

test('dispatcher resumptions call native helpers and spill only on exits',async t=>{
 if(!supportsWasmJsTag()){t.pass('engine retains supported bridges');t.end();return;}
 const classpath=compile(t,'NativeResumeCaller',`public class NativeResumeCaller {
   static int effects;
   static int drive(int[] a,int n){effects++;return 10+NativeResumeHelper.walk(a,n);}
   static int outer(int[] a,int n){return 100+drive(a,n);}
   static int caught(int[] a,int n){try{return 50+drive(a,n);}catch(ArrayIndexOutOfBoundsException e){return -7;}}
   static int local(int n){int r=0;for(int i=0;i<n;i++)r+=i;return r;}
   static Object reference(Object value){return NativeResumeHelper.reference(value);}
   static long wide(long value){return 13L+NativeResumeHelper.wide(value);}
   static Object rejected(int[] a){NativeResumeHelper.walk(a,1);return a.clone();}
 }
 class NativeResumeHelper {
   static int calls,initializations,observed;
   static int marker=init();
   static int init(){initializations++;observed=NativeResumeCaller.effects;return 1;}
   static int walk(int[] a,int n){calls++;int sum=0;for(int i=0;i<n;i++)sum+=a[i];return sum;}
   static Object reference(Object value){calls++;return value;}
   static long wide(long value){calls++;return value*3L;}
 }`);
 const j=new JVM({classpath,wasmHeap:true,wasmHeapMb:1,jit:{codegen:false,compileWorker:false,retainCompilerDiagnostics:false,
   wasm:{structured:true,maxInlineCalleeItems:1,canonicalDirectCalls:true,canonicalEhLinks:true,nativeJsExceptionTags:true}}});
 await j.preloadClasspathClasses();
 for(const owner of ['NativeResumeCaller','NativeResumeHelper'])j._markClassInitialized(owner);
 const helper=j.classes.NativeResumeHelper.staticFields,caller=j.classes.NativeResumeCaller.staticFields;
 for(const name of ['calls','initializations','observed','marker'])helper.set(name+':I',0);
 caller.set('effects:I',0);
 const w=j.jit.wasmJit;w.enabled=true;
 const prepare=(owner,name,desc,structured)=>{
  const method=j.findMethod(j.classes[owner],name,desc),state=w.methodState({method});
  w.structuredEnabled=structured;w.compile({method,className:owner},state,{asCallee:true});
  t.equal(state.status,'ready',state.lastCompileError||name+' compiles');return state;
 };
 const walk=prepare('NativeResumeHelper','walk','([II)I',true);
 prepare('NativeResumeHelper','reference','(Ljava/lang/Object;)Ljava/lang/Object;',true);
 prepare('NativeResumeHelper','wide','(J)J',true);
 const drive=prepare('NativeResumeCaller','drive','([II)I',false);
 const reference=prepare('NativeResumeCaller','reference','(Ljava/lang/Object;)Ljava/lang/Object;',false);
 const wide=prepare('NativeResumeCaller','wide','(J)J',false);
 const outer=prepare('NativeResumeCaller','outer','([II)I',false);
 const caught=prepare('NativeResumeCaller','caught','([II)I',false);
 const local=prepare('NativeResumeCaller','local','(I)I',true);
 t.equal(drive.meta.canonicalDispatcherCalls,1,'dispatcher emits the canonical call path');
 t.ok(drive.meta.deoptableCalls>0,'native suspension cannot be misclassified as a never-exiting raw link');
 const a=j.wasmHeap.alloc('[I',3);a.set([2,3,4]);
 const invoke=async(state,args)=>{
  const frame=new Frame(state.method),carrier=new Frame(state.method);
  frame.className='NativeResumeCaller';let slot=0;
  const {params}=parseMethodDescriptor(state.method.descriptor);
  args.forEach((arg,index)=>{frame.locals[slot]=arg;slot+=params[index]==='J'||params[index]==='D'?2:1;});
  const thread={id:0,status:'runnable',callStack:new Stack()};
  thread.callStack.push(carrier);thread.callStack.push(frame);j.threads=[thread];j.currentThreadIndex=0;
  w.execute(frame,thread,state,0);
  let ticks=0;while(thread.callStack.size()>1){await j.executeTick();if(++ticks>100000)throw Error('native dispatcher resume limit');}
  return carrier.stack.pop();
 };
 const entries=walk.meta.canonicalEntries.value;
 for(let i=0;i<3;i++)t.equal(await invoke(drive,[a,3]),19,'native caller preserves operands below the invocation');
 t.equal(walk.meta.canonicalEntries.value,entries+3,'all successful calls entered the canonical export');
 t.equal(walk.nestedCalls||0,0,'normal calls allocate no bridge scratch frames');
 t.equal(walk.meta.directFrameContext.createdFrames,0,'normal calls allocate no canonical frames');
 t.equal(helper.get('calls:I'),3,'normal helper effects execute once');
 const oldEntries=walk.meta.canonicalEntries;
 prepare('NativeResumeHelper','walk','([II)I',true);
 t.equal(await invoke(drive,[a,3]),19,'existing dispatcher follows a replacement publication');
 t.equal(oldEntries.value,entries+3,'replacement does not keep invoking the superseded export');
 t.equal(walk.meta.canonicalEntries.value,1,'replacement receives the next call');
 const {MethodTranslator}=require('../src/jit/WasmJit')._test;
 const raw=new MethodTranslator(j,drive.method,'NativeResumeCaller',w).translate();
 const spill=raw.importObject.env.spill_all;let spills=0;
 raw.importObject.env.spill_all=(...values)=>{spills++;return spill(...values);};
 const rawFrame=new Frame(drive.method);rawFrame.locals[0]=a;rawFrame.locals[1]=3;raw.box.frame=rawFrame;
 const rawRun=new WebAssembly.Instance(new WebAssembly.Module(raw.bytes),raw.importObject).exports.run;
 const rawArgs=raw.paramSlots.map(p=>rawFrame.locals[p.slot]??(p.t===0x7e?0n:p.t===0x6f?null:0));
 t.equal(rawRun(...rawArgs,0,1000000),-1,'instrumented dispatcher completes normally');
 t.equal(spills,0,'successful native calls do not cross the frame-spill import');
 w.canonicalDirectLinks.release(raw.canonicalSlots);raw.box.frame=null;
 const beforeSlots=w.canonicalDirectLinks.bySlot.size;
 const rejected=j.findMethod(j.classes.NativeResumeCaller,'rejected','([I)Ljava/lang/Object;'),rejectedState=w.methodState({method:rejected});
 w.structuredEnabled=false;w.compile({method:rejected,className:'NativeResumeCaller'},rejectedState,{asCallee:true});
 t.notEqual(rejectedState.status,'ready','unsupported reference-returning module is rejected');
 t.equal(w.canonicalDirectLinks.bySlot.size,beforeSlots,'rejected translation releases its native call slots');
 const oldMeta=local.meta,oldRun=local.run,oldOsr=local.osr,Module=WebAssembly.Module;let modules=0;
 t.ok(oldOsr,'replacement test has an OSR companion');
 WebAssembly.Module=new Proxy(Module,{construct(target,args){
   if(++modules===2)throw new WebAssembly.CompileError('test: reject OSR companion');
   return Reflect.construct(target,args);
 }});
 try{w.structuredEnabled=true;w.compile({method:local.method,className:'NativeResumeCaller'},local,{asCallee:true});}
 finally{WebAssembly.Module=Module;}
 t.equal(modules,2,'test rejects the companion after validating the replacement primary');
 t.equal(local.status,'ready','failed replacement preserves ready state');
 t.equal(local.meta,oldMeta,'failed companion preserves the old metadata');
 t.equal(local.run,oldRun,'failed companion preserves the old executable');
 t.equal(local.osr,oldOsr,'failed companion preserves the old OSR module');
 t.equal(await invoke(local,[4]),6,'old executable still runs after rejected replacement');
 w.freezeCompilation();j.jit._syncCompileEnvironment={trace:false,assert:true};j.jit.markMainStarted();
 const marker={type:'java/lang/Object',fields:{}};
 t.equal(await invoke(reference,[marker]),marker,'native reference return preserves exact identity');
 t.equal(await invoke(wide,[4294967297n]),12884901904n,'category-two arguments and under-stack values are exact');
 const callsBeforeFuel=helper.get('calls:I'),effectsBeforeFuel=caller.get('effects:I');
 walk.meta.canonicalFuel.value=1;
 t.equal(await invoke(drive,[a,3]),19,'fuel exit completes the callee before resuming the caller');
 t.equal(helper.get('calls:I'),callsBeforeFuel+1,'callee write before fuel exit is never replayed');
 t.equal(caller.get('effects:I'),effectsBeforeFuel+1,'caller write before fuel exit is never replayed');
 t.equal(walk.meta.directFrameContext.frames.size,0,'fuel handoff consumes its owning frame');
 const callsBeforeNested=helper.get('calls:I');
 walk.meta.canonicalFuel.value=1;
 t.equal(await invoke(outer,[a,3]),119,'nested dispatcher bridge preserves the suspended native grandchild');
 t.equal(helper.get('calls:I'),callsBeforeNested+1,'nested fuel exit never replays callee effects');
 t.equal(walk.meta.directFrameContext.frames.size,0,'nested handoff consumes the grandchild frame');
 walk.meta.canonicalFuel.value=100000000;
 const callsBeforeWithdraw=helper.get('calls:I');
 w.canonicalDirectLinks.withdraw(walk.key);
 t.equal(await invoke(drive,[a,3]),19,'withdrawn slot resumes at the original invocation with its arguments');
 t.equal(helper.get('calls:I'),callsBeforeWithdraw+1,'withdrawal runs the helper once');
 w.canonicalDirectLinks.publish(walk);
 j.classInitializationState.delete('NativeResumeHelper');
 const effectsBeforeInit=caller.get('effects:I');
 t.equal(await invoke(drive,[a,3]),19,'cold owner follows ordinary initialization');
 t.equal(helper.get('initializations:I'),1,'owner initializer executes once');
 t.equal(helper.get('observed:I'),effectsBeforeInit+1,'initializer observes the original preceding write');
 for(const [args,type] of [[[a,4],'java/lang/ArrayIndexOutOfBoundsException'],[[null,1],'java/lang/NullPointerException']]){
  const before=helper.get('calls:I');let error;try{await invoke(drive,args);}catch(caught){error=caught;}
  t.equal(error?.type,type,'native callee propagates exact guest '+type);
  t.equal(helper.get('calls:I'),before+1,'exception does not replay callee effects');
 }
 t.equal(await invoke(caught,[a,4]),-7,'legacy EH caller catches the exact nested native exception');
 t.equal(j.jit.syncCompileCensus().postMainSyncCompileCount,0,'all continuations remain compilation-free');
 t.end();
});

test('replaced dispatcher modules release their canonical table slots',async t=>{
 if(!global.gc||!supportsWasmJsTag()){t.pass('requires forced GC and native tags');t.end();return;}
 const classpath=compile(t,'NativeSlotLifetime',`public class NativeSlotLifetime {
  static int leaf(int[] a){return a[0];}
  static int caller(int[] a){return 1+leaf(a);}
 }`);
 const j=new JVM({classpath,wasmHeap:true,jit:{codegen:false,compileWorker:false,retainCompilerDiagnostics:false,
  wasm:{structured:true,maxInlineCalleeItems:1,canonicalDirectCalls:true,canonicalEhLinks:true,nativeJsExceptionTags:true}}});
 await j.preloadClasspathClasses();j._markClassInitialized('NativeSlotLifetime');
 const w=j.jit.wasmJit,leaf=j.findMethod(j.classes.NativeSlotLifetime,'leaf','([I)I'),caller=j.findMethod(j.classes.NativeSlotLifetime,'caller','([I)I');
 w.compile({method:leaf,className:'NativeSlotLifetime'},w.methodState({method:leaf}),{asCallee:true});
 const state=w.methodState({method:caller});w.structuredEnabled=false;
 const replace=()=>w.compile({method:caller,className:'NativeSlotLifetime'},state,{asCallee:true});
 const retire=()=>{replace();const meta=state.meta;return {meta:new WeakRef(meta),slots:meta.canonicalSlots.slice()};};
 const retired=retire();replace();
 t.equal(retired.slots.length,1,'retired module owns one native binding');
 for(let i=0;i<14;i++){await new Promise(setImmediate);global.gc();}
 t.equal(retired.meta.deref(),undefined,'superseded dispatcher metadata is collectible');
 t.ok(retired.slots.every(slot=>!w.canonicalDirectLinks.bySlot.has(slot)),'retired bindings return to the free list');
 t.ok(state.meta.canonicalSlots.every(slot=>w.canonicalDirectLinks.bySlot.has(slot)),'replacement bindings stay live');
 t.end();
});

'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm');
const Frame=require('../src/core/frame');
const Stack=require('../src/core/stack');
const {booleanStaticCaptures}=require('../src/jit/wasmShared');
const fixture=require('./javaFixture').makeJavaFixtureCompiler('structured-loop-resume-');
const source=`public class ResumeProof {
 static int prefixes,steps,tails,calls;
 static boolean mode;
 static int integer(int n){prefixes++;int sum=1000+prefixes;
  for(int i=0;i<n;i++){steps++;sum=sum*33+i;}tails++;return sum;}
 static long wide(int n,long seed){prefixes++;long sum=seed;
  for(int i=0;i<n;i++){steps++;sum=sum*31+i;}tails++;return sum;}
 static double sign(int n,double x){prefixes++;
  for(int i=0;i<n;i++){steps++;x=-x;}tails++;return x;}
 static int array(int[] a){prefixes++;int sum=0;
  for(int i=0;i<a.length;i++){steps++;a[i]++;sum+=a[i];}tails++;return sum;}
 static Object reference(Object keep,int n){prefixes++;Object value=keep;keep=null;
  for(int i=0;i<n;i++){steps++;if(value==null)return null;}tails++;return value;}
 static int helper(){calls++;return calls&7;}
 static int calling(int n){prefixes++;int sum=0;
  for(int i=0;i<n;i++){steps++;sum+=helper();}tails++;return sum;}
 static int prebranch(int n){if(n==0)prefixes+=10;else prefixes++;
  int sum=prefixes;for(int i=0;i<n;i++){steps++;sum+=i;}tails++;return sum;}
 static int captured(int n){boolean saved=mode;if(saved)prefixes++;
  int sum=0;for(int i=0;i<n;i++){steps++;sum+=i;}tails++;return sum;}
 static int caught(int n){int sum=0;for(int i=0;i<n;i++){
  try{sum+=100/(i-2);}catch(ArithmeticException e){sum+=7;}}return sum;}
 static int castArray(Object raw,int n){prefixes++;int sum=0;
  for(int i=0;i<n;i++){steps++;sum+=((int[])raw)[i];}tails++;return sum;}
 static int instance(ResumeCell cell,int n){prefixes++;int sum=0;
  for(int i=0;i<n;i++){steps++;sum+=cell.value;}tails++;return sum;}
 static int instanceAlias(ResumeCell cell,int n){prefixes++;ResumeCell kept=cell;cell=null;int sum=0;
  for(int i=0;i<n;i++){steps++;sum+=kept.value;}tails++;return sum;}
 static int relayCell(ResumeCell cell){calls++;return cell.value;}
 static int callingCell(ResumeCell cell,int n){prefixes++;int sum=0;
  for(int i=0;i<n;i++){steps++;sum+=relayCell(cell);}tails++;return sum;}
}
class ResumeCell {int value;}`;
for(const heap of [false,true])test(`structured loop resume reconstructs state without replay (heap=${heap})`,async t=>{
 const classpath=fixture(t,'ResumeProof',source);
 const j=new JVM({classpath,wasmHeap:heap,wasmFields:heap,wasmHeapMb:1,prepareBeforeMain:false,
  jit:{codegen:true,compileWorker:false,retainCompilerDiagnostics:false,
   wasm:{structured:true,checkcast:true,canonicalDirectCalls:true,canonicalEhLinks:true,nativeJsExceptionTags:true}}});
 await j.preloadClasspathClasses();j._markClassInitialized('ResumeProof');
 const w=j.jit.wasmJit;w.enabled=true;
 const prepare=(name,descriptor)=>{
  const method=j.findMethod(j.classes.ResumeProof,name,descriptor),state=w.methodState({method});
  w.compile({method,className:'ResumeProof'},state,{asCallee:true});
  t.equal(state.status,'ready',state.failReason||name+' compiles');return state;
 };
 prepare('helper','()I');
 prepare('relayCell','(LResumeCell;)I');
 const integer=prepare('integer','(I)I'),wide=prepare('wide','(IJ)J'),sign=prepare('sign','(ID)D'),
  array=prepare('array','([I)I'),reference=prepare('reference','(Ljava/lang/Object;I)Ljava/lang/Object;'),
  calling=prepare('calling','(I)I'),prebranch=prepare('prebranch','(I)I'),
  captured=prepare('captured','(I)I'),caught=prepare('caught','(I)I'),
  castArray=prepare('castArray','(Ljava/lang/Object;I)I'),
  instance=prepare('instance','(LResumeCell;I)I'),instanceAlias=prepare('instanceAlias','(LResumeCell;I)I'),
  callingCell=prepare('callingCell','(LResumeCell;I)I');
 t.equal(caught.meta.structuredResumeEntry,null,'exception regions retain the supported resume path');
 if(heap){
  t.equal(castArray.meta.objectStorageInputCount,1,'cast method receives an unused native object input');
  t.equal(instance.meta.objectStorageInputCount,1,'field reader receives a used native object input');
  t.ok(instance.meta.structuredResumeEntry,'used native argument storage is reconstructed lazily');
 }
 w.freezeCompilation();j.jit._syncCompileEnvironment={trace:false,assert:true};j.jit.markMainStarted();
 const fields=j.classes.ResumeProof.staticFields;
 const run=async(state,args,n,invalidate=false,afterYield)=>{
  for(const key of ['prefixes','steps','tails','calls'])fields.set(key+':I',0);
  t.ok(state.meta.structuredResumeEntry,state.key+' has a proved loop header');
  const frame=new Frame(state.method),carrier=new Frame(state.method);frame.className='ResumeProof';
  let slot=0;for(const value of args){frame.locals[slot]=value;slot+=typeof value==='bigint'||state===sign&&slot===1?2:1;}
  const thread={id:0,status:'runnable',callStack:new Stack(),pendingException:null};
  thread.callStack.push(carrier);thread.callStack.push(frame);j.threads=[thread];j.currentThreadIndex=0;
  const raw=state.run,execute=w.execute.bind(w),transitions=[],jitEnabled=j.jit.enabled;
  state.run=(...values)=>{values[values.length-1]=2;return raw(...values);};
  w.execute=(f,th,s,...rest)=>{
   if(s===state)transitions.push({pc:f.pc,osr:!!rest[2]});return execute(f,th,s,...rest);
  };
  try{
   let ticks=0;
   while(thread.callStack.size()>1){
    await j.executeTick();if(++ticks>1000)throw Error('resume failed to make progress');
    if(state===captured&&thread.callStack.peek()===frame&&w.hasStructuredResumePoint(frame))
     for(const capture of booleanStaticCaptures(state.method))t.equal(frame.locals[capture.slot],1,'captured metadata survives a subsequent native spill');
    if(invalidate&&ticks===1){j.classInitializationState.delete('ResumeProof');j.jit.enabled=false;}
    if(afterYield&&ticks===1)afterYield();
   }
  }finally{state.run=raw;w.execute=execute;j.jit.enabled=jitEnabled;}
  t.ok(transitions.length>1,'forced fuel exhaustion crosses the scheduler');
  if(!invalidate){
   t.ok(transitions.every(x=>!x.osr),'every re-entry keeps structured Wasm');
   t.ok(transitions.slice(1).every(x=>x.pc===state.meta.structuredResumeEntry.item),'resume starts at the exact saved header');
  }else t.pass('cold readiness guard can hand execution back to canonical bytecode');
  t.equal(fields.get('prefixes:I'),1,'prefix side effect runs once');
  t.equal(fields.get('steps:I'),n,'loop effects run once per iteration');
  t.equal(fields.get('tails:I'),1,'tail side effect runs once');
  t.equal(state.meta.box.frame,null,'completed entry releases its frame');
  t.ok([...(w.nativeObjectInputGlobals?.values()||[])].flat().every(input=>input.value.value===null),
   'native argument globals retain no references after resumption');
  return carrier.stack.pop();
 };
 let expected=1001;for(let i=0;i<5;i++)expected=(Math.imul(expected,33)+i)|0;
 t.equal(await run(integer,[5],5),expected,'integer loop phis are reconstructed');
 let long=9007199254740993n;for(let i=0;i<5;i++)long=BigInt.asIntN(64,long*31n+BigInt(i));
 t.equal(await run(wide,[5,9007199254740993n],5),long,'wide locals keep every bit');
 t.ok(Object.is(await run(sign,[5,-0],5),0),'double negative zero survives each resume');
 const a=new Int32Array([3,7,11,19,23]);
 t.equal(await run(array,[a],5),68,'foreign array resume computes exact sum');
 t.deepEqual([...a],[4,8,12,20,24],'array writes are never replayed');
 const kept={type:'java/lang/Object',fields:{}};
 t.equal(await run(reference,[kept,5],5),kept,'reference alias survives an overwritten argument slot');
 const values=Object.assign(new Int32Array([2,3,5,7,11]),{type:'[I'});
 t.equal(await run(castArray,[values,5],5),28,'Object-to-array casts keep exact references across native resumptions');
 const {makeObjectRef,newFields,writeField}=require('../src/core/objectModel');
 const cell=makeObjectRef(j,'ResumeCell',newFields(j,'ResumeCell'));
 writeField(cell.fields,'ResumeCell.value',7);
 t.equal(await run(instance,[cell,5],5),35,'field readers recover native storage after each yield');
 t.equal(await run(instanceAlias,[cell,5],5),35,'native storage follows the saved alias after its argument slot is overwritten');
 t.equal(await run(callingCell,[cell,5],5),35,'resumed callers forward freshly recovered native storage to child entries');
 t.equal(fields.get('calls:I'),5,'native child effects execute exactly once per resumed iteration');
 t.equal(await run(instance,[cell,5],5,false,()=>{cell.fields={'ResumeCell.value':11};}),51,
  'a replaced field container is observed after resumption without replaying earlier reads');
 t.equal(await run(calling,[5],5),15,'helper loop remains exact after fuel exits');
 t.equal(fields.get('calls:I'),5,'helper side effects execute once per iteration');
 t.equal(await run(prebranch,[5],5),11,'conditional prefix and merge are skipped exactly once');
 t.equal(await run(integer,[5],5,true),expected,'readiness invalidation after a yield makes progress without replay');
 fields.set('mode:Z',1);
 t.equal(await run(captured,[5],5),10,'captured flag metadata is retained even after its final Java use');
 t.equal(j.jit.syncCompileCensus().postMainSyncCompileCount,0,'all resumptions are compilation-free');
 t.end();
});

'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm'),Frame=require('../src/core/frame'),Stack=require('../src/core/callStack');
const {newFields,makeObjectRef}=require('../src/core/objectModel');
const {takeWasmReturnValue}=require('../src/jit/wasmShared');
const compile=require('./javaFixture').makeJavaFixtureCompiler('inline-atomic-leaf-');
const source=`public class AtomicLeafProbe {
 static int prefixes,steps,tails,helperCalls,initializedAt;static int[] input;
}
class AtomicLeaf {
 static int[] data;static int cursor;
 static {data=AtomicLeafProbe.input;AtomicLeafProbe.initializedAt=AtomicLeafProbe.prefixes;}
 static int next(){int v=data[cursor];cursor++;AtomicLeafProbe.helperCalls++;return v;}
 static int noFields(int x){return x+1;}
 static int partial(int[] a){AtomicLeafProbe.helperCalls++;a[0]++;return a[1];}
 static int handled(int[] a){try{return a[0];}catch(ArrayIndexOutOfBoundsException e){return 55;}}
}
final class AtomicRunner {
 final int scan(){AtomicLeafProbe.prefixes++;int sum=0,v;
  while((v=AtomicLeaf.next())>=0){AtomicLeafProbe.steps++;sum=sum*31+v;}
  AtomicLeafProbe.tails++;return sum;}
 int run(){return 7+scan();}
 int caught(){try{return 7+scan();}catch(ArrayIndexOutOfBoundsException e){
  return AtomicLeafProbe.helperCalls*1000+AtomicLeaf.cursor*10+AtomicLeafProbe.steps;}}
 final int noFieldScan(int n){AtomicLeafProbe.prefixes++;int i=0,sum=0;while(i<n){
  sum+=AtomicLeaf.noFields(i);i+=(i&1)+1;}AtomicLeafProbe.tails++;return sum;}
 int noFieldRoot(int n){return 7+noFieldScan(n);}
 final int partialScan(int[] a,int n){AtomicLeafProbe.prefixes++;int i=0,sum=0;while(i<n){
  AtomicLeafProbe.steps++;sum+=AtomicLeaf.partial(a);i+=(i&1)+1;}AtomicLeafProbe.tails++;return sum;}
 int faultRoot(int[] a,int n){try{return 7+partialScan(a,n);}catch(RuntimeException e){
  return AtomicLeafProbe.helperCalls*100+(a==null?-1:a[0]);}}
 final int handledScan(int[] a,int n){int i=0,sum=0;while(i<n){sum+=AtomicLeaf.handled(a);i+=(i&1)+1;}return sum;}
 int handledRoot(int[] a,int n){return 7+handledScan(a,n);}
}`;

test('atomic static leaf splices preserve cold first use, partial faults and loop-header fuel',async t=>{
 const classpath=compile(t,'AtomicLeafProbe',source),j=new JVM({classpath,wasmHeap:true,wasmFields:true,
  jit:{enabled:false,compileWorker:false,retainCompilerDiagnostics:false,wasmStructured:true,
   wasm:{deepInline:false,canonicalDirectCalls:true,canonicalEhLinks:true,nativeJsExceptionTags:true}}});
 await j.preloadClasspathClasses();for(const owner of ['AtomicLeafProbe','AtomicRunner'])j._markClassInitialized(owner);
 const w=j.jit.wasmJit;w.enabled=true;
 const prepare=(owner,name,desc)=>{const method=j.findMethod(j.classes[owner],name,desc),s=w.methodState({method});
  w.compile({method,className:owner},s,{asCallee:true});t.equal(s.status,'ready',s.lastCompileError||name+' installs');return s;};
 prepare('AtomicLeaf','handled','([I)I');
 const run=prepare('AtomicRunner','run','()I'),caught=prepare('AtomicRunner','caught','()I'),
  noFields=prepare('AtomicRunner','noFieldRoot','(I)I'),fault=prepare('AtomicRunner','faultRoot','([II)I'),
  handled=prepare('AtomicRunner','handledRoot','([II)I');
 for(const s of [run,caught,noFields,fault]){
  t.equal(s.meta.inlineActivationSiteCount,1,'loop has a recoverable original activation');
  t.equal(s.meta.inlineAtomicStaticSiteCount,1,'acyclic static leaf is spliced without deep-inline flags');
  t.ok(s.meta.normalFlowFullyCompiled,'composition keeps complete normal flow');
 }
 t.equal(handled.meta.inlineAtomicStaticSiteCount,0,'meaningful leaf handlers keep a real invocation');
 const probe=j.classes.AtomicLeafProbe.staticFields,leaf=j.classes.AtomicLeaf.staticFields;
 const array=xs=>{const a=j.wasmHeap.alloc('[I',xs.length);a.type='[I';a.set(xs);return a;};
 const owner=makeObjectRef(j,'AtomicRunner',newFields(j,'AtomicRunner'));
 const reset=()=>{for(const k of ['prefixes','steps','tails','helperCalls'])probe.set(k+':I',0);leaf.set('cursor:I',0);};
 const raw=(s,args,fuel=1000000)=>{const frame=new Frame(s.method);frame.className='AtomicRunner';frame.locals[0]=owner;
  args.forEach((a,i)=>frame.locals[i+1]=a);s.meta.box.frame=frame;
  try{return {frame,status:s.run(owner,...args,0,fuel)};}finally{s.meta.box.frame=null;}};
 const threadFor=frame=>{const carrier=new Frame(frame.method),thread={id:0,status:'runnable',callStack:new Stack()};
  thread.callStack.push(carrier);thread.callStack.push(frame);j.threads=[thread];j.currentThreadIndex=0;return {thread,carrier};};
 const finish=async(thread,carrier)=>{
  for(let ticks=0;thread.callStack.size()>1&&ticks<10000;ticks++){
   const f=thread.callStack.peek(),at=f.pc++,item=f.instructions[at];
   if(item?.instruction)try{await j.executeInstruction(item.instruction,f,thread);}catch(e){
    j.handleException(e,item.labelDef?parseInt(item.labelDef.slice(1,-1)):at,thread);
   }
  }
  t.equal(thread.callStack.size(),1,'original bytecode continuation retires');return carrier.stack.pop();
 };
 w.freezeCompilation();j.jit._syncCompileEnvironment={trace:false,assert:true};j.jit.markMainStarted();
 reset();probe.set('initializedAt:I',-1);probe.set('input:[I',array([3,5,-1]));
 const untaken=raw(noFields,[0]),untakenState=threadFor(untaken.frame);
 t.equal(untaken.status,0,'cold untaken dependency retains conservative entry fallback');
 t.equal(await finish(untakenState.thread,untakenState.carrier),7,'zero-trip fallback does not invoke the leaf');
 t.equal(probe.get('initializedAt:I'),-1,'untaken leaf does not initialize its class');
 t.notEqual(j.classInitializationState.get('AtomicLeaf'),'INITIALIZED','first-use dependency remains cold');
 reset();
 const cold=raw(run,[]);
 t.equal(cold.status,0,'cold dependency refuses at the original outer entry');
 t.equal(probe.get('prefixes:I'),0,'cold guard executes no prefix effects');
 t.equal(probe.get('initializedAt:I'),-1,'cold guard does not initialize the class early');
 const c=threadFor(cold.frame);
 t.equal(await finish(c.thread,c.carrier),105,'cold fallback executes the original composition');
 t.equal(probe.get('initializedAt:I'),1,'first-use initializer observes the preceding callee prefix');
 t.equal(probe.get('prefixes:I'),1,'cold prefix runs once');t.equal(probe.get('helperCalls:I'),3,'cold leaf calls exact');
 reset();const warm=raw(run,[]);
 t.equal(warm.status,-1,'warm composition stays in Wasm');t.equal(takeWasmReturnValue(run.meta),105,'warm result exact');
 t.equal(probe.get('prefixes:I'),1,'warm prefix once');t.equal(probe.get('steps:I'),2,'warm steps exact');
 t.equal(probe.get('helperCalls:I'),3,'all helper writes execute');
 t.equal(probe.get('tails:I'),1,'warm tail once');
 // A call can be the very first instruction of the non-counted loop header.
 // Its entry marker must retain the original activation PC for the fuel exit.
 reset();leaf.set('data:[I',array([3]));const f=new Frame(caught.method);f.className='AtomicRunner';f.locals[0]=owner;
 const suspended=threadFor(f),original=caught.run;caught.run=(...args)=>{args[args.length-1]=2;return original(...args);};
 try{w.execute(f,suspended.thread,caught,0);}finally{caught.run=original;}
 t.equal(suspended.thread.callStack.size(),3,'loop-header fuel reconstructs exactly one inner frame');
 const child=suspended.thread.callStack.peek(),next=child.instructions[child.pc].instruction;
 t.equal(child.method.name,'scan','suspension names the real loop method');
 t.equal(next?.op,'invokestatic','fuel resume is before the original helper invoke');
 t.equal(probe.get('helperCalls:I'),1,'first helper call happened exactly once before yielding');
 t.equal(await finish(suspended.thread,suspended.carrier),1011,'later helper fault reaches the outer handler without replay');
 t.equal(leaf.get('cursor:I'),1,'failing read does not repeat the earlier cursor store');
 t.equal(probe.get('prefixes:I'),1,'suspended prefix is never replayed');
 for(const a of [array([40]),null]){
  reset();const result=raw(fault,[a,2]),state=threadFor(result.frame);
  t.equal(result.status,-3,'native leaf fault uses the existing precise outer handler path');
  const exn=fault.meta.box.pendingException;fault.meta.box.pendingException=null;
  j.handleException(exn,fault.meta.box.throwPc,state.thread);
  t.equal(await finish(state.thread,state.carrier),a?141:99,'partial helper effects precede the exact Java fault');
  t.equal(probe.get('helperCalls:I'),1,'throwing helper prefix once');
  if(a)t.equal(a[0],41,'preceding array store happens once');
 }
 reset();j.classInitializationState.delete('AtomicLeaf');
 t.equal(raw(noFields,[5]).status,0,'leaf with no static-field accesses retains its class dependency after initialization reset');
 t.equal(probe.get('prefixes:I'),0,'no-field leaf refusal does not replay or initialize');
 j._markClassInitialized('AtomicLeaf');
 const noFieldResult=raw(noFields,[5]);t.equal(noFieldResult.status,-1,'same no-field body executes when ready');
 t.equal(takeWasmReturnValue(noFields.meta),14,'no-field leaf arithmetic stays exact');
 const handlerResult=raw(handled,[array([]),2]),handlerState=threadFor(handlerResult.frame);
 const pending=handled.meta.box.pendingFrames;handled.meta.box.pendingFrames=null;
 t.ok(pending?.some(f=>f.method.name==='handled'),'handler-bearing helper donates its real caught continuation');
 for(let i=(pending?.length||0)-1;i>=0;i--)handlerState.thread.callStack.push(pending[i]);
 t.equal(await finish(handlerState.thread,handlerState.carrier),117,'helper catches its own bounds faults');
 t.equal(j.jit.syncCompileCensus().postMainSyncCompileCount,0,'all continuations stay compilation-free');
 t.end();
});

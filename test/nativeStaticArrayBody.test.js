'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm'),Frame=require('../src/core/frame'),Stack=require('../src/core/callStack');
const Compiler=require('../src/jit/StructuredWasmCompiler');
const {takeWasmReturnValue}=require('../src/jit/wasmShared');
const compile=require('./javaFixture').makeJavaFixtureCompiler('native-static-array-body-');
const terms=Array.from({length:20},(_,i)=>`sum+=a[(i+${i})&31]*0.5f;`).join('');
test('one native array body guards representation and preserves fallback and partial effects',async t=>{
 const source=`public class StaticArrayBody {
 static float[] first,second;static int progress;
 static float kernel(int count,boolean choose){float sum=0;float[] a=choose?first:second;
  for(int i=0;i<count;i++){${terms}a[i]=sum;}return sum;}
 static float caller(int count,boolean choose){progress++;float result=kernel(count,choose);progress+=10;return result;}
 static float caught(int count){try{return kernel(count,true);}catch(ArrayIndexOutOfBoundsException e){progress+=100;return -7;}}
 static float withCall(int count){float sum=0;for(int i=0;i<count;i++){${terms.replaceAll('a[','first[')}sum+=other();}return sum;}
 static float other(){progress++;return 1;}
 static float tiny(){return first[0];}
 static float swap(int count){float sum=0;float[] a=first,b=second;for(int i=0;i<count;i++){
  float[] tmp=a;a=b;b=tmp;${terms}a[i]=sum;}return sum;}
 }`;
 const classpath=compile(t,'StaticArrayBody',source),j=new JVM({classpath,wasmHeap:true,wasmFields:true,
  jit:{enabled:false,compileWorker:false,retainCompilerDiagnostics:false,wasmStructured:true,wasm:{deepInline:false,
   canonicalDirectCalls:true,canonicalEhLinks:true,nativeJsExceptionTags:true}}});
 await j.preloadClasspathClasses();j._markClassInitialized('StaticArrayBody');
 const w=j.jit.wasmJit,fields=j.classes.StaticArrayBody.staticFields;w.importStatsEnabled=true;
 const build=(name,descriptor)=>{
  const method=j.findMethod(j.classes.StaticArrayBody,name,descriptor),state=w.methodState({method});
  w.compile({method,className:'StaticArrayBody'},state,{asCallee:true});
  t.equal(state.status,'ready',state.lastCompileError||name+' compiles');return state;
 };
 const kernel=build('kernel','(IZ)F'),caller=build('caller','(IZ)F'),caught=build('caught','(I)F');
 t.ok(kernel.meta.nativeStaticArrayBodySites>=16,'substantial array body takes the guarded representation');
 t.notOk(kernel.meta.structuredResumeEntry,'suspended specialized bodies use the established fallback');
 t.ok(kernel.meta.deoptableCalls>0,'callers must support an entry refusal');
 t.ok(caller.meta.canonicalDirectSites>0,'ordinary callers retain a native call link');
 const native=values=>{const a=j.wasmHeap.alloc('[F',values.length);a.type='[F';a.set(values);return a;};
 const data=Array.from({length:32},(_,i)=>i+1);
 const raw=(state,args,fuel=1e8)=>{
  const frame=new Frame(state.method);state.meta.box.frame=frame;
  try{return {status:state.run(...args,0,fuel),value:state.meta.box.ret,frame};}
  finally{state.meta.box.frame=null;}
 };
 const execute=async(state,args,fuel=1e8)=>{
  const f=new Frame(state.method);f.className='StaticArrayBody';args.forEach((x,i)=>f.locals[i]=x);
  const thread={id:0,status:'runnable',callStack:new Stack()};thread.callStack.push(f);j.threads=[thread];j.currentThreadIndex=0;
  state.meta.canonicalFuel.value=fuel;const result=w.execute(f,thread,state,0);let value=result.value,steps=0;
  while(!thread.callStack.isEmpty()&&++steps<100000){
   const current=thread.callStack.peek(),ins=current.instructions[current.pc++].instruction;
   if(/^[ilfda]return$/.test(typeof ins==='string'?ins:ins?.op))value=current.stack.peek();
   if(ins)await j.executeInstruction(ins,current,thread);
  }
  t.ok(thread.callStack.isEmpty(),'continuation completes');return value;
 };
 fields.set('first:[F',native(data));fields.set('second:[F',native(data));
 const first=fields.get('first:[F'),expected=raw(kernel,[2,1]);
 t.equal(expected.status,-1,'native body returns normally');t.ok(expected.value>0,'native arithmetic executes');
 t.equal(kernel.meta.importStats.get('native_static_arrays_entered'),1,'entry guard actually selects the body');
 t.equal(kernel.meta.importStats.get('abase')||0,0,'no per-access base queries');
 t.equal(kernel.meta.importStats.get('alen0')||0,0,'no per-access length queries');
 fields.set('first:[F',native(data));fields.set('progress:I',0);
 t.equal(await execute(caller,[2,1]),expected.value,'native caller result remains exact');
 t.equal(fields.get('progress:I'),11,'caller effects occur once');
 for(const foreign of [Object.assign([...data],{type:'[F'}),null]){
  fields.set('first:[F',foreign);const result=raw(kernel,[0,1]);
  t.equal(result.status,0,'entry refusal happens before any Java effects');
  t.equal(result.frame.locals[0],0,'refusal materializes original count');
  t.equal(result.frame.locals[1],1,'refusal materializes original branch');
  t.equal(await execute(caller,[0,1]),0,'zero-trip fallback keeps null/foreign references legal');
 }
 const plain=Object.assign([...data],{type:'[F'});fields.set('first:[F',plain);fields.set('progress:I',0);
 t.equal(await execute(caller,[2,1]),expected.value,'foreign fallback through canonical parent returns exact result');
 t.equal(fields.get('progress:I'),11,'fallback caller effects happen once');
 fields.set('first:[F',native(data));fields.set('progress:I',0);
 t.equal(await execute(caller,[2,1],1),expected.value,'low fuel completes with exact suspended state');
 t.equal(fields.get('progress:I'),11,'low-fuel handoff preserves caller effects');
 const captured=native(data),unused=native(new Array(32).fill(10000));fields.set('first:[F',captured);
 const suspended=raw(kernel,[3,1],2);t.ok(suspended.status>0,'low fuel suspends after a real iteration');
 fields.set('first:[F',unused);suspended.frame.pc=suspended.status;suspended.frame.className='StaticArrayBody';
 const resumedThread={id:0,status:'runnable',callStack:new Stack()};resumedThread.callStack.push(suspended.frame);
 j.threads=[resumedThread];j.currentThreadIndex=0;let finalValue,steps=0;
 while(!resumedThread.callStack.isEmpty()&&++steps<100000){
  const frame=resumedThread.callStack.peek(),ins=frame.instructions[frame.pc++].instruction;
  if(/^[ilfda]return$/.test(typeof ins==='string'?ins:ins?.op))finalValue=frame.stack.peek();
  if(ins)await j.executeInstruction(ins,frame,resumedThread);
 }
 fields.set('first:[F',native(data));const three=raw(kernel,[3,1]).value;
 t.equal(finalValue,three,'suspended invocation keeps its saved old array after field replacement');
 t.deepEqual([...unused],new Array(32).fill(10000),'resumption never writes the replacement field array');
 const swap=build('swap','(I)F');t.ok(swap.meta.nativeStaticArrayBodySites>0,'cyclic reference phis receive a positive proof');
 const left=native(data),right=native(data.map(x=>x*3)),leftOracle=new Float32Array(left),rightOracle=new Float32Array(right);
 let a=leftOracle,b=rightOracle,swapSum=0;
 for(let i=0;i<3;i++){[a,b]=[b,a];for(let k=0;k<20;k++)swapSum=Math.fround(swapSum+Math.fround(a[(i+k)&31]*0.5));a[i]=swapSum;}
 fields.set('first:[F',left);fields.set('second:[F',right);
 t.equal(raw(swap,[3]).value,swapSum,'parallel native metadata swaps preserve the exact result');
 t.deepEqual([...left],[...leftOracle],'first swapped storage has exact writes');
 t.deepEqual([...right],[...rightOracle],'second swapped storage has exact writes');
 const short=native([3]);fields.set('first:[F',short);fields.set('progress:I',0);
 t.equal(await execute(caught,[1]),-7,'native bounds fault reaches the original caller handler');
 t.equal(fields.get('progress:I'),100,'handler executes once');
 t.ok((kernel.meta.directFrameContext.throwCount||0)+(kernel.callee?.meta?.directFrameContext?.throwCount||0)>0,
  'JS-tagged native faults contribute to the exception census');
 t.equal(short[0],3,'stores after an earlier fault never happen');
 const progressArray=native(data),oracle=new Float32Array(data);let sum=0;
 for(let i=0;i<33;i++){
  for(let k=0;k<20;k++)sum=Math.fround(sum+Math.fround(oracle[(i+k)&31]*0.5));
  if(i<32)oracle[i]=sum;
 }
 fields.set('first:[F',progressArray);fields.set('progress:I',0);
 t.equal(await execute(caught,[33]),-7,'a later native store fault reaches the handler');
 t.deepEqual([...progressArray],[...oracle],'every preceding write survives the late bounds failure exactly');
 const otherHeap=new (require('../src/core/wasmHeap').WasmHeap)(1),foreign=otherHeap.alloc('[F',32);foreign.set(data);
 fields.set('first:[F',foreign);
 t.equal(raw(kernel,[2,1]).status,0,'foreign-memory owned arrays refuse the native body');
 t.equal(await execute(caller,[2,1]),expected.value,'foreign-memory fallback retains numerical correctness');
 const cell=fields.cell('first:[F');let gets=0;
 Object.defineProperty(cell,'value',{configurable:true,get(){gets++;return native(data);}});
 t.equal(gets,0,'guard preparation never runs the getter');
 t.equal(raw(kernel,[0,1]).status,0,'accessor representation refuses without executing Java');
 t.equal(gets,0,'entry guard does not invoke custom getters');
 t.equal(await execute(caller,[0,1]),0,'custom getter fallback preserves zero-trip result');
 t.equal(gets,1,'original field read executes exactly once during fallback');
 const tiny=build('tiny','()F');t.equal(tiny.meta.nativeStaticArrayBodySites,0,'small methods retain their existing representation');
 const callback=build('withCall','(I)F');t.equal(callback.meta.nativeStaticArrayBodySites,0,'callbacks refuse the closed native body proof');
 t.notEqual(first,fields.get('first:[F'),'replacing a field does not pin its earlier reference in compiler graphs');
 const method=j.findMethod(j.classes.StaticArrayBody,'kernel','(IZ)F'),compiler=new Compiler(j,method,'StaticArrayBody',w);
 const meta=compiler.translateWith(true);
 t.ok(meta.nativeStaticArrayBodySites>0,'retention fixture really has a positive proof');
 t.equal(compiler.nativeStaticArrayBody,undefined,'native proof graph releases after compilation');
 t.equal(compiler.nativeStaticArrayReads,undefined,'field-reader graph releases after compilation');
 if(global.gc){
  Object.defineProperty(cell,'value',{configurable:true,writable:true,value:null});
  const weak=(()=>{const old=native(data);fields.set('first:[F',old);raw(kernel,[1,1]);return new WeakRef(old);})();
  fields.set('first:[F',native(data));
  for(let i=0;i<10;i++){await new Promise(setImmediate);global.gc();}
  t.equal(weak.deref(),undefined,'replaced array collects while native compiled bodies remain live');
 }
 t.end();
});

test('region readiness facts are reused without initializing a cold untaken dependency',async t=>{
 const reads=terms.replaceAll('a[','RegionArrayOwner.data[');
 const classpath=compile(t,'RegionReadiness',`class RegionArrayOwner {static float[] data;static {RegionReadiness.effects+=1000;}}
 public class RegionReadiness {static int effects;
  static float run(int count){effects++;float[] allocation=new float[1];float sum=0;
   for(int i=0;i<count;i++){${reads}}effects+=10;return sum;}
 }`);
 const j=new JVM({classpath,wasmHeap:true,wasmFields:true,jit:{enabled:false,compileWorker:false,retainCompilerDiagnostics:false,
  wasmStructured:true,wasm:{deepInline:false,canonicalDirectCalls:true,canonicalEhLinks:true,nativeJsExceptionTags:true}}});
 await j.preloadClasspathClasses();j._markClassInitialized('RegionReadiness');
 const fields=j.classes.RegionReadiness.staticFields,owner=j.classes.RegionArrayOwner.staticFields;
 const data=j.wasmHeap.alloc('[F',32);data.type='[F';data.set(Array.from({length:32},(_,i)=>i+1));owner.set('data:[F',data);
 const method=j.findMethod(j.classes.RegionReadiness,'run','(I)F'),w=j.jit.wasmJit,state=w.methodState({method});
 w.compile({method,className:'RegionReadiness'},state,{asCallee:true});t.equal(state.status,'ready',state.lastCompileError||'cold owner compiles');
 t.ok(state.meta.nativeStaticArrayRegions.length>0,'field-read loop has a guarded region');
 t.ok(state.meta.nativeReadinessGuardsReusedCount>0,'real loop-body readiness checks use the existing entry fact');
 const frame=new Frame(method);frame.className='RegionReadiness';state.meta.box.frame=frame;
 let status;try{status=state.run(0,0,1e8);}finally{state.meta.box.frame=null;}
 t.ok(status>0,'cold owner refuses at the later boundary');t.equal(fields.get('effects:I'),1,'prefix precedes readiness refusal');
 frame.pc=status;const thread={id:0,status:'runnable',callStack:new Stack()};thread.callStack.push(frame);j.threads=[thread];j.currentThreadIndex=0;
 let result,steps=0;while(!thread.callStack.isEmpty()&&++steps<10000){
  const current=thread.callStack.peek(),ins=current.instructions[current.pc++].instruction;
  if(/^[ilfda]return$/.test(typeof ins==='string'?ins:ins?.op))result=current.stack.peek();if(ins)await j.executeInstruction(ins,current,thread);
 }
 t.equal(result,0,'zero-trip fallback returns normally');t.equal(fields.get('effects:I'),11,'prefix is not replayed');
 t.notEqual(j.classInitializationState.get('RegionArrayOwner'),'INITIALIZED','untaken field dependency stays uninitialized');
 j._markClassInitialized('RegionArrayOwner');fields.set('effects:I',0);state.meta.box.frame=new Frame(method);
 try{t.equal(state.run(2,0,1e8),-1,'ready guarded region runs natively');t.equal(takeWasmReturnValue(state.meta),220,'native arithmetic remains exact');}
 finally{state.meta.box.frame=null;}
 t.equal(fields.get('effects:I'),11,'ready region retains prefix/suffix effects');
 const compiler=new Compiler(j,method,'RegionReadiness',w);compiler.translateWith(false);
 t.equal(compiler.nativeReadinessProofSites,undefined,'readiness proof sites release with compiler diagnostics');
 t.equal(compiler.nativeStaticArrayBody,undefined,'region graph releases after compilation');
 t.end();
});

test('closed native regions guard incoming edges without replaying prefixes or leaking proofs past callbacks',async t=>{
 const source=`public class ArrayRegions {
 static int progress;static float[] allocated,shared,next;
 static float[] region(Object input,int count){progress++;allocated=new float[1];float[] a=(float[])input;float sum=0;
  for(int i=0;i<count;i++){${terms}a[i]=sum;}progress+=10;return a;}
 static float[] caller(Object input,int count){progress+=100;float[] a=region(input,count);progress+=1000;return a;}
 static void barrier(){${'progress++;'.repeat(120)}shared=next;}
 static float[] two(int count){progress++;float[] a=shared;float sum=0;
  for(int i=0;i<count;i++){${terms}a[i]=sum;}barrier();a=shared;sum=0;
  for(int i=0;i<count;i++){${terms}a[i]=sum;}progress+=10;return a;}
 }`;
 const classpath=compile(t,'ArrayRegions',source),j=new JVM({classpath,wasmHeap:true,wasmFields:true,jit:{enabled:false,
  compileWorker:false,retainCompilerDiagnostics:false,wasmStructured:true,wasm:{deepInline:false,checkcast:true,
   canonicalDirectCalls:true,canonicalEhLinks:true,nativeJsExceptionTags:true}}});
 await j.preloadClasspathClasses();j._markClassInitialized('ArrayRegions');const w=j.jit.wasmJit;w.importStatsEnabled=true;
 const fields=j.classes.ArrayRegions.staticFields,build=(name,descriptor)=>{
  const method=j.findMethod(j.classes.ArrayRegions,name,descriptor),s=w.methodState({method});
  w.compile({method,className:'ArrayRegions'},s,{asCallee:true});t.equal(s.status,'ready',s.lastCompileError||name+' compiles');return s;
 };
 const region=build('region','(Ljava/lang/Object;I)[F'),caller=build('caller','(Ljava/lang/Object;I)[F');
 build('barrier','()V');const two=build('two','(I)[F');
 t.ok(region.meta.nativeStaticArrayRegions.length>0,'instance-compatible reference-returning code has a proved region');
 t.ok(region.meta.nativeStaticArrayRegions[0].entry>0,'guard belongs to a region after prefix effects');
 t.ok(two.meta.nativeStaticArrayRegions.length>=2,'separate regions surround a callback');
 t.notOk(region.meta.structuredResumeEntry,'external resumption cannot skip region guards');
 const data=Array.from({length:32},(_,i)=>i+1),native=xs=>{const a=j.wasmHeap.alloc('[F',xs.length);a.type='[F';a.set(xs);return a;};
 const reference=(a,n)=>{let sum=0;for(let i=0;i<n;i++){for(let k=0;k<20;k++)sum=Math.fround(sum+Math.fround(a[(i+k)&31]*0.5));a[i]=sum;}return a;};
 const raw=(state,args,fuel=1e8)=>{
  const frame=new Frame(state.method);frame.className='ArrayRegions';state.meta.box.frame=frame;
  try{const status=state.run(...args,0,fuel);return {status,value:status===-1?takeWasmReturnValue(state.meta):undefined,frame};}finally{state.meta.box.frame=null;}
 };
 const finish=async(frame)=>{
  const thread={id:0,status:'runnable',callStack:new Stack()};thread.callStack.push(frame);j.threads=[thread];j.currentThreadIndex=0;
  let value,steps=0;while(!thread.callStack.isEmpty()&&++steps<100000){
   const current=thread.callStack.peek(),ins=current.instructions[current.pc++].instruction;
   if(/^[ilfda]return$/.test(typeof ins==='string'?ins:ins?.op))value=current.stack.peek();
   if(ins)await j.executeInstruction(ins,current,thread);
  }t.ok(thread.callStack.isEmpty(),'saved region continuation completes');return value;
 };
 const a=native(data);fields.set('progress:I',0);
 t.equal(raw(region,[a,2]).status,-1,'native region returns normally');
 t.deepEqual([...a],[...reference(new Float32Array(data),2)],'all native writes match float arithmetic');
 t.equal(fields.get('progress:I'),11,'native prefix and suffix execute exactly once');
 const entered=[...region.meta.importStats].filter(([key])=>key.startsWith('native_array_region_entered_')).reduce((sum,[,n])=>sum+n,0);
 t.equal(entered,1,'outside entry is guarded once, not on every loop backedge');
 for(const input of [null,Object.assign([...data],{type:'[F'})]){
  fields.set('progress:I',0);const result=raw(region,[input,0]),allocation=fields.get('allocated:[F');
  t.ok(result.status>0,'unknown storage refuses at the later region boundary');
  t.equal(fields.get('progress:I'),1,'prefix has already executed before refusal');
  result.frame.pc=result.status;
  t.equal(await finish(result.frame),input,'zero-trip continuation preserves reference identity');
  t.equal(fields.get('progress:I'),11,'refusal never replays prefix or loses suffix');
  t.equal(fields.get('allocated:[F'),allocation,'prefix allocation is not replayed');
 }
 let lengthReads=0;const observable=Object.assign([...data],{type:'[F'});
 // An object view supplies an observable length without native provenance.
 const view={type:'[F'};for(let i=0;i<32;i++)view[i]=observable[i];
 Object.defineProperty(view,'length',{get(){lengthReads++;t.equal(fields.get('progress:I'),1,'metadata getter stays after prefix');return 32;}});
 fields.set('progress:I',0);const refused=raw(region,[view,0]);
 t.equal(lengthReads,0,'owned-header guard executes no length getter');
 refused.frame.pc=refused.status;await finish(refused.frame);t.equal(lengthReads,0,'zero-trip fallback never accesses length');
 const old=native(data);fields.set('progress:I',0);const suspended=raw(region,[old,3],2);
 t.ok(suspended.status>0,'fuel suspension retains original region state');suspended.frame.pc=suspended.status;
 t.equal(await finish(suspended.frame),old,'suspended reference return preserves identity');
 t.deepEqual([...old],[...reference(new Float32Array(data),3)],'fuel handoff preserves every partial store');
 fields.set('shared:[F',native(data));fields.set('next:[F',native(data.map(x=>x*3)));fields.set('progress:I',0);
 const first=fields.get('shared:[F'),second=fields.get('next:[F'),result=raw(two,[2]);
 t.equal(result.status,-1,'two guarded regions remain in native execution');
 t.equal(result.value,second,'second region observes the callback replacement');
 t.deepEqual([...first],[...reference(new Float32Array(data),2)],'first region retains first storage');
 t.deepEqual([...second],[...reference(new Float32Array(data.map(x=>x*3)),2)],'second region authenticates new storage');
 t.equal(fields.get('progress:I'),131,'callback and surrounding effects run once');
 fields.set('progress:I',0);const f=new Frame(caller.method);f.className='ArrayRegions';f.locals[0]=null;f.locals[1]=0;
 const thread={id:0,status:'runnable',callStack:new Stack()};thread.callStack.push(f);j.threads=[thread];j.currentThreadIndex=0;
 caller.meta.canonicalFuel.value=1e8;const call=w.execute(f,thread,caller,0);
 t.ok(call.handled,'canonical caller handles a region refusal');
 // w.execute may attach suspended child frames to this same thread.
 let returned,steps=0;while(!thread.callStack.isEmpty()&&++steps<100000){
  const frame=thread.callStack.peek(),ins=frame.instructions[frame.pc++].instruction;
  if(/^[ilfda]return$/.test(typeof ins==='string'?ins:ins?.op))returned=frame.stack.peek();if(ins)await j.executeInstruction(ins,frame,thread);
 }
 t.equal(returned,null,'canonical reference-return fallback completes');t.equal(fields.get('progress:I'),1111,'canonical guard refusal preserves all caller effects');
 t.end();
});

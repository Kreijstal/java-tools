'use strict';
// Tests a JS or partial-Wasm tier: the closed-world module would take its methods.
process.env.JVM_CLOSED_WORLD = '0';
const test=require('tape');
const {JVM}=require('../src/core/jvm');
const Frame=require('../src/core/frame');
const Stack=require('../src/core/stack');
const {supportsWasmJsTag}=require('../src/jit/wasmShared');
const fixture=require('./javaFixture').makeJavaFixtureCompiler('array-identity-');

test('identity proof budget refuses excess groups before allocating Wasm locals',t=>{
 const prepare=require('../src/jit/arrayIdentityCaches').prepare;
 const caches=Array.from({length:65},(_,id)=>({value:{id:100+id,op:'checkcast',block:0,args:[{id,op:'param'}]}}));
 const c={heap:{},arrayCaches:new Map(caches.map((cache,i)=>[i,cache])),
  fn:{referenceFacts:{identity:value=>value.args[0]}},nextLocal:10,declared:[]};
 prepare(c,{tree:{t:'loop',body:{t:'straight',block:0}}});
 t.equal(c.nextLocal,10,'refusal consumes no local indices');
 t.equal(c.declared.length,0,'refusal adds no local declarations');
 t.notOk(c.arrayIdentityGroups,'refusal publishes no incomplete proof');
 t.ok(caches.every(cache=>!cache.identityGroup),'existing metadata queries remain unchanged');
 t.end();
});

test('cast aliases share positive native metadata without caching type verdicts',async t=>{
 if(!supportsWasmJsTag()){t.pass('engine retains supported fallback');t.end();return;}
 const classpath=fixture(t,'ArrayIdentityProof',`public class ArrayIdentityProof {
  static int effects;
  static int scan(Object input,int n){int sum=0;for(int i=0;i<n;i++){effects++;sum+=((int[])input)[i&1];}return sum;}
  static int replace(Object first,Object second,int n){Object a=first;int sum=0;for(int i=0;i<n;i++){if(i==2)a=second;sum+=((int[])a)[i&1];}return sum;}
  static int swap(Object a,Object b,int n){int sum=0;for(int i=0;i<n;i++){sum+=((int[])a)[0]+((int[])b)[1];Object old=a;a=b;b=old;}return sum;}
  static int lengths(Object a,Object b,int n){int sum=0;for(int i=0;i<n;i++){sum+=((int[])a).length;Object old=a;a=b;b=old;}return sum;}
  static int table(int[][] rows,int n){Object a=rows[0];int sum=0;for(int i=0;i<n;i++){if((i&1)!=0)a=rows[1];sum+=((int[])a)[i&1];}return sum;}
  static int skipped(Object input,boolean skip){if(skip)return -7;effects++;return ((int[])input)[0];}
  static int caught(Object input){int sum=0;try{for(int i=0;i<3;i++){effects++;sum+=((int[])input)[i];}}
    catch(ArrayIndexOutOfBoundsException e){return sum+100;}return sum;}
  static Object castOnly(Object input){effects++;return (int[])input;}
  static int instanceOnly(Object input){effects++;return input instanceof int[]?1:0;}
 }`);
 const j=new JVM({classpath,wasmHeap:true,wasmFields:true,jit:{codegen:false,compileWorker:false,retainCompilerDiagnostics:false,
  wasm:{structured:true,checkcast:true,maxInlineCalleeItems:1,canonicalDirectCalls:true,canonicalEhLinks:true,nativeJsExceptionTags:true}}});
 await j.preloadClasspathClasses();j._markClassInitialized('ArrayIdentityProof');
 const w=j.jit.wasmJit;w.enabled=true;w.importStatsEnabled=true;
 const prepare=(name,descriptor)=>{const method=j.findMethod(j.classes.ArrayIdentityProof,name,descriptor),state=w.methodState({method});
  w.compile({method,className:'ArrayIdentityProof'},state,{asCallee:true});t.equal(state.status,'ready',state.lastCompileError||name+' compiles');return state;};
 const scan=prepare('scan','(Ljava/lang/Object;I)I'),replace=prepare('replace','(Ljava/lang/Object;Ljava/lang/Object;I)I');
 const skipped=prepare('skipped','(Ljava/lang/Object;Z)I'),caught=prepare('caught','(Ljava/lang/Object;)I');
 const swap=prepare('swap','(Ljava/lang/Object;Ljava/lang/Object;I)I');
 const lengthSwap=prepare('lengths','(Ljava/lang/Object;Ljava/lang/Object;I)I');
 const table=prepare('table','([[II)I');
 const castOnly=prepare('castOnly','(Ljava/lang/Object;)Ljava/lang/Object;');
 const instanceOnly=prepare('instanceOnly','(Ljava/lang/Object;)I');
 const array=values=>{const a=j.wasmHeap.alloc('[I',values.length);a.type='[I';a.set(values);return a;};
 const a=array([2,7]),b=array([11,13]);
 const {makeNativeReferenceArray}=require('../src/core/nativeReferenceArray');
 const rows=makeNativeReferenceArray(j,Object.assign([a,b],{type:'[[I',elementType:'[I'}));
 w.freezeCompilation();j.jit._syncCompileEnvironment={trace:false,assert:true};j.jit.markMainStarted();
 t.equal(scan.meta.canonicalRun(a,10)[3],45,'native aliases compute exact elements');
 t.equal(scan.meta.importStats.get('abase'),1,'ten casts query a native base once');
 t.equal(scan.meta.importStats.get('alen0'),1,'ten casts query native length once');
 t.equal(scan.meta.importStats.get('cast__I'),10,'every original type check still executes');
 t.equal(scan.meta.canonicalRun(b,4)[3],48,'a new invocation captures a different array');
 t.equal(scan.meta.importStats.get('abase'),2,'native metadata is invocation-local');
 t.equal(replace.meta.canonicalRun(a,b,6)[3],57,'loop-carried replacement invalidates aliases');
 t.equal(swap.meta.canonicalRun(a,b,5)[3],81,'simultaneous loop-carried swaps preserve each array proof');
 t.equal(swap.meta.importStats.get('abase'),2,'swapped native metadata transfers without another query');
 t.equal(lengthSwap.meta.canonicalRun(array([2]),array([3,5,7]),5)[3],9,'swapped proofs keep distinct array lengths');
 const shorter=replace.meta.canonicalRun(a,array([11]),4);
 t.equal(shorter[0],-5,'replacing with a shorter array never reuses old bounds');
 t.equal(shorter[2].box.lastThrown.type,'java/lang/ArrayIndexOutOfBoundsException','replacement keeps the exact bounds exception');
 t.equal(table.meta.canonicalRun(rows,6)[3],63,'row metadata follows conditional loop joins');
 t.equal(table.meta.importStats.get('abase')||0,0,'captured row headers reach casts through phis without queries');
 t.equal(table.meta.canonicalRun(Object.assign([a,b],{type:'[[I'}),6)[3],63,'uncaptured reference arrays preserve checked fallback');
 const plain=Object.assign([3,5],{type:'[I'}),before=scan.meta.importStats.get('alen0');
 t.equal(scan.meta.canonicalRun(plain,4)[3],16,'ordinary arrays retain imported element access');
 t.equal(scan.meta.importStats.get('alen0')-before,4,'negative native proofs never suppress original metadata queries');
 const alias=new Int32Array(j.wasmHeap.memory.buffer,a.byteOffset,2);
 alias.type='[I';alias.wasmBase=alias.byteOffset;let aliasLengths=0;
 Object.defineProperty(alias,'length',{get(){aliasLengths++;return 2;}});
 const aliasBefore=scan.meta.importStats.get('alen0');
 t.equal(scan.meta.canonicalRun(alias,4)[3],18,'untracked host views keep valid native accesses');
 t.equal(scan.meta.importStats.get('alen0')-aliasBefore,4,'an untracked positive base is not an ownership proof');
 t.equal(aliasLengths,4,'every original host-view length getter remains observable');
 let lengths=0;const wrong={type:'java/lang/Object',get length(){lengths++;throw Error('early length');}};
 t.equal(skipped.meta.canonicalRun(wrong,1)[3],-7,'unused cast is not executed');
 const failed=skipped.meta.canonicalRun(wrong,0);
 t.equal(failed[0],-5,'failed cast keeps its native exception protocol');
 t.equal(failed[2].box.lastThrown.type,'java/lang/ClassCastException','failed cast still throws CCE');
 t.equal(lengths,0,'metadata never queries an unused or unsuccessfully cast reference');
 let typeReads=0,source='[I';
 const changing={get type(){typeReads++;return source;},get length(){throw Error('cast read array metadata');}};
 t.equal(castOnly.meta.canonicalRun(changing)[3],changing,'exact array cast preserves reference identity');
 t.equal(instanceOnly.meta.canonicalRun(changing)[3],1,'exact array instanceof succeeds');
 t.equal(typeReads,2,'each exact type check reads its host type once');
 source='[B';
 const changedCast=castOnly.meta.canonicalRun(changing);
 t.equal(changedCast[0],-5,'a changed host type never inherits a positive verdict');
 t.equal(changedCast[2].box.lastThrown.type,'java/lang/ClassCastException','changed type keeps the cast exception');
 t.equal(instanceOnly.meta.canonicalRun(changing)[3],0,'changed host type makes instanceof false');
 source='[I';
 t.equal(castOnly.meta.canonicalRun(changing)[3],changing,'a later exact type is observed again');
 const {allocPrimitiveArray,allocMultiArray}=require('../src/instructions/object');
 const {classIndexOf}=require('../src/core/objectModel');
 for(const atype of ['boolean','byte','char','short','int','long','float','double']){
  const value=allocPrimitiveArray(j,atype,1),cast=castOnly.meta.canonicalRun(value);
  t.equal(value.cidx,classIndexOf(j,value.type),'owned '+atype+' array has its actual class index');
  if(atype==='int')t.equal(cast[3],value,'owned int array cast preserves identity');
  else t.equal(cast[2].box.lastThrown.type,'java/lang/ClassCastException','owned '+atype+' array rejects int[] cast');
  t.equal(instanceOnly.meta.canonicalRun(value)[3],atype==='int'?1:0,'owned '+atype+' array has the correct instanceof verdict');
 }
 const foreignVm=new JVM({wasmHeap:true,wasmHeapMb:1,jit:{enabled:false,compileWorker:false}});
 classIndexOf(foreignVm,'UnrelatedClassLoadedFirst');
 const foreignInt=allocPrimitiveArray(foreignVm,'int',2);
 t.equal(foreignInt.cidx,classIndexOf(j,'[I'),'primitive class identities agree across independent VM class orders');
 t.equal(castOnly.meta.canonicalRun(foreignInt)[3],foreignInt,'another VM\'s int array casts correctly');
 t.equal(instanceOnly.meta.canonicalRun(allocPrimitiveArray(foreignVm,'byte',1))[3],0,'another VM\'s byte array never aliases int[]');
 const matrix=allocMultiArray(j,'[[I',[2,1]);
 t.equal(matrix[0].cidx,classIndexOf(j,'[I'),'multidimensional allocation tags each primitive row');
 t.equal(castOnly.meta.canonicalRun(matrix[1])[3],matrix[1],'multidimensional rows retain exact cast identity');
 t.throws(()=>allocPrimitiveArray(j,'int',-1),error=>error.type==='java/lang/NegativeArraySizeException',
  'negative allocation retains its guest exception');
 const thrown={hostTypeFailure:true},throwing={get type(){throw thrown;}};
 const hostCast=castOnly.meta.canonicalRun(throwing);
 t.equal(hostCast[0],-5,'throwing type getters keep the exception protocol');
 t.equal(hostCast[2].box.lastThrown,thrown,'throwing type getters preserve throwable identity');
 for(const value of [null,undefined]){
  t.equal(castOnly.meta.canonicalRun(value)[3],null,'nullish casts normalize to Java null');
  t.equal(instanceOnly.meta.canonicalRun(value)[3],0,'nullish instanceof stays false');
 }
 const nullRead=skipped.meta.canonicalRun(null,0);
 t.equal(nullRead[0],-5,'successful null cast fails at the dereference');
 t.equal(nullRead[2].box.lastThrown.type,'java/lang/NullPointerException','null still throws NPE');
 const fields=j.classes.ArrayIdentityProof.staticFields;
 const invoke=async(state,values,fuel)=>{
  const frame=new Frame(state.method),carrier=new Frame(state.method);frame.className='ArrayIdentityProof';
  values.forEach((value,index)=>{frame.locals[index]=value;});
  const thread={id:0,status:'runnable',callStack:new Stack()};thread.callStack.push(carrier);thread.callStack.push(frame);
  j.threads=[thread];j.currentThreadIndex=0;const original=state.run;
  if(fuel!==undefined)state.run=(...args)=>{args[args.length-1]=fuel;return original(...args);};
  try{w.execute(frame,thread,state,0);}finally{state.run=original;}
  let ticks=0;while(thread.callStack.size()>1){await j.executeTick();if(++ticks>100000)throw Error('cast alias continuation limit');}
  return carrier.stack.pop();
 };
 fields.set('effects:I',0);
 t.equal(await invoke(scan,[a,6],1),27,'fuel continuation keeps original array and loop sum');
 t.equal(fields.get('effects:I'),6,'fuel exit never replays writes');
 fields.set('effects:I',0);
 t.equal(await invoke(caught,[a]),109,'handler receives the exact partial sum');
 t.equal(fields.get('effects:I'),3,'bounds failure keeps preceding effects once');
 t.equal(j.jit.syncCompileCensus().postMainSyncCompileCount,0,'continuations attempt no compilation');
 if(global.gc){
  const Compiler=require('../src/jit/StructuredWasmCompiler');
  const compiler=new Compiler(j,scan.method,'ArrayIdentityProof',w),translate=compiler.translateBody;
  let graph,groups;
  compiler.translateBody=function(...args){const result=translate.apply(this,args);
   graph=new WeakRef(this.fn);groups=new WeakRef(this.arrayIdentityGroups);return result;};
  const metadata=compiler.translateWith(false);
  t.ok(metadata.importObject.env,'runtime imports remain alive during collection test');
  for(let i=0;i<12;i++){await new Promise(setImmediate);global.gc();}
  t.equal(graph.deref(),undefined,'installed imports do not retain the SSA graph');
  t.equal(groups.deref(),undefined,'installed imports do not retain array identity analysis');
 }
 t.end();
});

'use strict';
const test=require('tape');
const {T,OP,sleb,uleb,assembleModule,supportsWasmTryTable}=require('../src/jit/wasmShared');

test('expanded array entry preserves the ordinary run and canonical ABIs',t=>{
 if(!supportsWasmTryTable()){t.pass('engine retains the existing entry');t.end();return;}
 for(const specokGlobal of [false,true]){
  const seen=[],owner={version:1};let ready=true;
  const globals=1+(specokGlobal?1:0);
  const body=[OP.i32_const,0,OP.global_set,...uleb(globals)];
  for(let i=0;i<6;i++)body.push(OP.local_get,...uleb(i));
  body.push(OP.call,1,OP.local_get,1,OP.global_set,0,
    OP.i32_const,...sleb(-1),OP.return,OP.end);
  const bytes=assembleModule({
    importDecls:[{name:'ready',params:[],results:[T.i32]},
      {name:'capture',params:[T.ref,T.i64,T.i32,T.i32,T.i32,T.i32],results:[]}],
    mainParams:[T.ref,T.i64,T.i32,T.i32,T.i32,T.i32],mainResults:[T.i32],
    declared:[],body,retvType:T.i64,runvWrapper:true,specokGlobal,
    canonicalFrameExport:{readyIdx:0},parameterArrayABI:[0],
  });
  const x=new WebAssembly.Instance(new WebAssembly.Module(bytes),{env:{
    ready:()=>ready?1:0,capture:(...args)=>seen.push(args)}}).exports;
  x.canonicalOwner.value=owner;x.canonicalFuel.value=29;
  const array=new Int32Array([1,2,3,4]);
  t.equal(x.run(array,99n,8,17),-1,'legacy frame entry keeps block and fuel positions');
  t.deepEqual(seen.pop(),[array,99n,-2,0,8,17],'uncaptured metadata is explicit at ordinary entry');
  t.deepEqual(x.runv(array,101n),[-1,101n],'raw linked entry keeps its original signature');
  t.deepEqual(seen.pop(),[array,101n,-2,0,0,100000000],'raw entry supplies original nested fuel');
  const plain=x.canonicalRun(array,102n);
  t.deepEqual(plain,[-1,1,owner,102n],'canonical owner, invocation and wide return remain intact');
  t.deepEqual(seen.pop(),[array,102n,-2,0,0,29],'ordinary canonical entry uses uncaptured metadata');
  const expanded=x.canonicalHeapRun(array,103n,48,4);
  t.deepEqual(expanded,[-1,2,owner,103n],'expanded entry retains the same canonical result protocol');
  t.deepEqual(seen.pop(),[array,103n,48,4,0,29],'captured base and length reach the same body');
  ready=false;
  t.deepEqual(x.canonicalHeapRun(array,104n,48,4),[-4,0,null,0n],
    'a cold owner refuses the expanded entry before running the body');
  t.equal(seen.length,0,'cold entry performs no guest or metadata work');
  ready=true;
  t.equal(x.run(array,105n,7,13),-1,'ordinary entry still works after a refused expanded call');
  t.deepEqual(seen.pop(),[array,105n,-2,0,7,13],'incoming metadata never persists between calls');
 }
 t.end();
});

async function harness(t) {
 const compile=require('./javaFixture').makeJavaFixtureCompiler('wasm-array-abi-');
 const classpath=compile(t,'ArrayMetadataProof',`public class ArrayMetadataProof {
   static int[] data;
   static int sum(int[] a,int n) { int s=0;for(int i=0;i<n;i++)s+=a[i];return s; }
   static int repeat(int[] a,int n,int times) { int s=0;for(int i=0;i<times;i++)s+=sum(a,n);return s; }
   static long sumWide(long start,int[] a,int n) { long s=start;for(int i=0;i<n;i++)s+=a[i];return s; }
   static long repeatWide(int[] a,int n,int times) { long s=0;for(int i=0;i<times;i++)s+=sumWide(10000000000L,a,n);return s; }
   static int foreign() { return ColdArrayMetadata.sum(data,2); }
   static int sharedFields(int[] a,int[] b) {
     int s=0;
     for(int i=0;i<3;i++) { data=a; s+=sum(data,1); data=b; s+=sum(data,1); }
     return s;
   }
   static int recursive(int[] a,int[] b,int n) {
     int x=a[0]; if(n==0)return x; return x+recursive(b,a,n-1);
   }
   static int protectedSum(int[] a,int n,int[] progress) {
     int s=0;
     try { for(int i=0;i<n;i++) { s+=a[i]; progress[0]++; } }
     catch(ArrayIndexOutOfBoundsException e) { progress[1]=s; return -31; }
     return s;
   }
   static int protectedCaller(int[] a,int n,int[] progress) { return protectedSum(a,n,progress)+5; }
 }
 class ColdArrayMetadata {
   static int initialized=17;
   static int sum(int[] a,int n) { int s=0;for(int i=0;i<n;i++)s+=a[i];return s; }
 }`);
 const {JVM}=require('../src/core/jvm'),Frame=require('../src/core/frame');
 const j=new JVM({classpath,wasmHeap:true,jit:{enabled:false,compileWorker:false,
   retainCompilerDiagnostics:false,wasmStructured:true,wasm:{deepInline:false,
     canonicalDirectCalls:true,canonicalEhLinks:true,canonicalLeafCalls:true,nativeJsExceptionTags:true}}});
 await j.preloadClasspathClasses();j.classInitializationState.set('ArrayMetadataProof','INITIALIZED');
 const w=j.jit.wasmJit;w.importStatsEnabled=true;
 const prepare=(owner,name,descriptor)=>{
   const method=j.findMethod(j.classes[owner],name,descriptor),st=w.methodState({method});
   w.compile({method,className:owner},st,{asCallee:true});
   t.equal(st.status,'ready',st.lastCompileError||name+' compiles');return st;
 };
 const run=(st,...args)=>{
   const frame=new Frame(st.method);frame.className=j.findClassNameForMethod(st.method);
   args.forEach((x,i)=>frame.locals[i]=x);st.meta.box.frame=frame;
   try {const status=st.run(...st.meta.paramSlots.map(p=>args[p.slot]),0,1000000);
     return {status,value:st.meta.box.ret,frame};}
   finally {st.meta.box.frame=null;}
 };
 const array=values=>{const a=j.wasmHeap.alloc('[I',values.length);a.type='[I';a.set(values);return a;};
 return {j,w,prepare,run,array};
}

test('compiled callers forward array metadata without per-callee JavaScript queries',async t=>{
 if(!supportsWasmTryTable()){t.pass('engine retains the bridge');t.end();return;}
 const h=await harness(t),sum=h.prepare('ArrayMetadataProof','sum','([II)I');
 const root=h.prepare('ArrayMetadataProof','repeat','([III)I');
 t.ok(sum.meta.canonicalHeapRun,'leaf exports expanded canonical entry');
 const a=h.array([2,3,5,7]);
 t.deepEqual(h.run(root,a,4,100).value,1700,'all repeated sums are exact');
 t.equal(root.meta.importStats.get('abase'),1,'caller captures the base once');
 t.equal(root.meta.importStats.get('alen0'),1,'caller captures the length once');
 t.equal(sum.meta.importStats.get('abase')||0,0,'one hundred callee entries query no bases');
 t.equal(sum.meta.importStats.get('alen0')||0,0,'one hundred callee entries query no lengths');
 t.equal(sum.meta.directFrameContext.createdFrames,0,'normal calls allocate no canonical frames');
 const heapExport=sum.meta.canonicalHeapRun,compactHeapExport=sum.meta.canonicalCompactHeapRun;
 sum.meta.canonicalHeapRun=null;sum.meta.canonicalCompactHeapRun=null;h.w.canonicalDirectLinks.publish(sum);
 t.equal(h.run(root,a,4,3).value,51,'an unavailable expanded export retains the legacy Java-argument fallback');
 sum.meta.canonicalHeapRun=heapExport;sum.meta.canonicalCompactHeapRun=compactHeapExport;h.w.canonicalDirectLinks.publish(sum);
 const b=h.array([11,13]);t.equal(h.run(root,b,2,3).value,72,'a fresh invocation uses its new array and length');
 const plain=Object.assign([17,19],{type:'[I'});
 t.equal(h.run(root,plain,2,4).value,144,'captured non-heap storage retains imported element access');
 t.equal(h.run(root,null,0,4).value,0,'unused null remains legal');
 t.throws(()=>h.run(root,null,1,1),e=>e.type==='java/lang/NullPointerException','used null keeps its guest exception');
 const before=sum.meta;
 h.w.compile({method:sum.method,className:'ArrayMetadataProof'},sum,{asCallee:true});
 t.notEqual(sum.meta,before,'replacement installs a new module');
 t.equal(h.run(root,b,2,3).value,72,'existing expanded binding reaches the replacement safely');
 t.equal(sum.meta.importStats.get('abase')||0,0,'replacement keeps forwarded metadata');
 t.end();
});

test('expanded calls retain exception/fuel continuations and active replacement ownership',async t=>{
 if(!supportsWasmTryTable()){t.pass('engine retains the bridge');t.end();return;}
 const h=await harness(t),leaf=h.prepare('ArrayMetadataProof','protectedSum','([II[I)I');
 const root=h.prepare('ArrayMetadataProof','protectedCaller','([II[I)I');
 const Frame=require('../src/core/frame'),CallStack=require('../src/core/callStack');
 const execute=async(a,n,progress)=>{
   const f=new Frame(root.method);f.className='ArrayMetadataProof';
   f.locals[0]=a;f.locals[1]=n;f.locals[2]=progress;
   const thread={id:0,status:'runnable',callStack:new CallStack()};thread.callStack.push(f);
   h.j.threads=[thread];h.j.currentThreadIndex=0;
   const result=h.w.execute(f,thread,root,0);let value=result.value,steps=0;
   while(!thread.callStack.isEmpty()&&++steps<10000){
     const current=thread.callStack.peek(),ins=current.instructions[current.pc++].instruction;
     if((typeof ins==='string'?ins:ins?.op)==='ireturn')value=current.stack.peek();
     if(ins)await h.j.executeInstruction(ins,current,thread);
   }
   t.ok(thread.callStack.isEmpty(),'owned continuation finishes without a replay loop');
   t.equal(leaf.meta.directFrameContext.frames.size,0,'callee releases transferred frames');
   return value;
 };
 let p=h.array([0,0]);
 t.equal(await execute(h.array([2,3]),3,p),-26,'caught bounds failure returns through the parent continuation');
 t.deepEqual([...p],[2,5],'handler receives exact partial effects and local sum');
 leaf.meta.canonicalFuel.value=1;p=h.array([0,0]);
 t.equal(await execute(h.array([2,3,5,7]),4,p),22,'fuel exit resumes with original Java locals');
 t.deepEqual([...p],[4,0],'fuel continuation performs every effect once');
 leaf.meta.canonicalFuel.value=100000000;
 const old=leaf.meta;let replacements=0;
 const plain=Object.assign([2,7],{type:'[I'});
 Object.defineProperty(plain,1,{get(){
   replacements++;h.w.compile({method:leaf.method,className:'ArrayMetadataProof'},leaf,{asCallee:true});
   throw {type:'java/lang/ArrayIndexOutOfBoundsException'};
 }});
 p=h.array([0,0]);
 t.equal(await execute(plain,2,p),-26,'an active old module owns its exception after replacement');
 t.deepEqual([...p],[1,2],'replacement never replays the throwing access or prior effects');
 t.equal(replacements,1,'the callback compiles a replacement exactly once');
 t.notEqual(leaf.meta,old,'active replacement actually changed the installed module');
 t.equal(old.directFrameContext.frames.size,0,'old owner releases its transferred frame');
 t.equal(old.box.pendingException,null,'old module releases the exception payload');
 t.end();
});

test('cold expanded callees preserve invocation order and recursive metadata stays local',async t=>{
 if(!supportsWasmTryTable()){t.pass('engine retains the bridge');t.end();return;}
 const h=await harness(t),leaf=h.prepare('ColdArrayMetadata','sum','([II)I');
 const caller=h.prepare('ArrayMetadataProof','foreign','()I');
 h.j.classes.ArrayMetadataProof.staticFields.set('data:[I',h.array([2,7]));
 const refused=h.run(caller);
 t.notEqual(refused.status,-1,'cold callee returns to ordinary invocation');
 t.equal(caller.meta.importStats.get('abase')||0,0,'cold call queries no new array metadata');
 t.equal(caller.meta.importStats.get('alen0')||0,0,'cold call queries no new lengths');
 t.notEqual(h.j.classInitializationState.get('ColdArrayMetadata'),'INITIALIZED','compilation never runs clinit early');
 h.j.classInitializationState.set('ColdArrayMetadata','INITIALIZED');
 t.equal(h.run(caller).value,9,'initialized callee runs with the original arguments');
 t.equal(leaf.meta.importStats.get('abase')||0,0,'nonparameter array cache forwards its captured metadata');
 t.equal(caller.meta.importStats.get('abase')||0,0,'native static array header supplies nonparameter metadata without a query');
 h.j.classes.ArrayMetadataProof.staticFields.set('data:[I',h.array([3,11]));
 t.equal(h.run(caller).value,14,'next invocation captures replacement static-array metadata');
 const recursive=h.prepare('ArrayMetadataProof','recursive','([I[II)I');
 t.equal(h.run(recursive,h.array([2]),h.array([7]),4).value,20,'recursive calls retain both arrays in their own parameter locals');
 t.equal(recursive.meta.importStats.get('abase'),2,'all recursion shares only the two captured bases');
 t.equal(recursive.meta.importStats.get('alen0'),2,'all recursion shares only the two captured lengths');
 t.equal(recursive.meta.directFrameContext.frames.size,0,'recursive normal returns retain no frames');
 t.end();
});

test('array entry imports do not retain the compiler graph when diagnostics are disabled',async t=>{
 if(!supportsWasmTryTable() || !global.gc){t.pass('run with --expose-gc for graph-retention validation');t.end();return;}
 const h=await harness(t);h.prepare('ArrayMetadataProof','sum','([II)I');
 const Compiler=require('../src/jit/StructuredWasmCompiler');
 const method=h.j.findMethod(h.j.classes.ArrayMetadataProof,'repeat','([III)I');
 const compiler=new Compiler(h.j,method,'ArrayMetadataProof',h.w);
 const translate=compiler.translateBody;let graph,parameter;
 compiler.translateBody=function(...args){
   const meta=translate.apply(this,args);
   graph=new WeakRef(this.fn);parameter=new WeakRef(this.fn.params[0]);return meta;
 };
 const meta=compiler.translateWith(false);
 t.ok(meta.importObject.env,'runtime imports remain installed');
 t.equal(compiler.heapParamLocals,undefined,'incoming parameter map is released');
 t.equal(compiler.arrayCaches,undefined,'forwarding caches are released');
 for(let i=0;i<8;i++){await new Promise(setImmediate);global.gc();}
 t.equal(graph.deref(),undefined,'the SSA function is collectible while imports stay alive');
 t.equal(parameter.deref(),undefined,'forwarding callbacks retain no SSA parameter/uses graph');
 t.ok(Object.keys(meta.importObject.env).length,'retained imports are still live after collection');
 t.end();
});

test('forwarded field-array metadata follows shared cache generations',async t=>{
 if(!supportsWasmTryTable()){t.pass('engine retains the bridge');t.end();return;}
 const h=await harness(t);h.w.sharedFieldArrayCachesEnabled=true;
 const leaf=h.prepare('ArrayMetadataProof','sum','([II)I');
 const root=h.prepare('ArrayMetadataProof','sharedFields','([I[I)I');
 t.ok(root.meta.sharedFieldArrayCacheCount>0,'the caller actually shares field-array metadata');
 t.equal(h.run(root,h.array([2]),h.array([7])).value,27,'successive field generations forward their own arrays');
 t.equal(h.run(root,h.array([2]),Object.assign([11],{type:'[I'})).value,39,'heap and plain field generations stay distinct');
 t.equal(leaf.meta.importStats.get('abase')||0,0,'callee receives every captured generation without a new query');
 t.end();
});

test('expanded compiled calls preserve category-two Java slot mapping',async t=>{
 if(!supportsWasmTryTable()){t.pass('engine retains the bridge');t.end();return;}
 const h=await harness(t),leaf=h.prepare('ArrayMetadataProof','sumWide','(J[II)J');
 const root=h.prepare('ArrayMetadataProof','repeatWide','([III)J');
 t.deepEqual(leaf.meta.parameterArrayABI,[1],'array metadata uses argument ordinal, not Java local slot');
 t.equal(h.run(root,h.array([2,3]),2,3).value,30000000015n,'long argument and result stay exact across expanded calls');
 t.equal(leaf.meta.importStats.get('abase')||0,0,'wide signature still uses forwarded array metadata');
 t.end();
});

test('a refused metadata fill cannot forward a default pointer after readiness changes',async t=>{
 if(!supportsWasmTryTable()){t.pass('engine retains the bridge');t.end();return;}
 const h=await harness(t),leaf=h.prepare('ColdArrayMetadata','sum','([II)I');
 const token=h.j.getClassInitializationToken('ColdArrayMetadata');
 let guardCalls=0;
 token.wasmReadinessGuard=()=>()=>{
   // Let the earlier static-call guard pass, then refuse the metadata fill
   // while publishing readiness for the callee's already compiled guard.
   if(++guardCalls===1)return 1;
   h.j.classInitializationState.set('ColdArrayMetadata','INITIALIZED');return 0;
 };
 const root=h.prepare('ArrayMetadataProof','foreign','()I');
 // An ordinary native static header already captures the metadata before
 // this call. Use a getter to exercise an uncaptured array and the refused
 // lazy fill, without changing the guest value or evaluating it twice.
 const data=h.array([2,7]);let reads=0;
 h.j.classes.ArrayMetadataProof.staticFields.set('data:[I',data);
 Object.defineProperty(h.j.classes.ArrayMetadataProof.staticFields.cell('data:[I'),'value',{
   configurable:true,get(){reads++;return data;}
 });
 t.equal(h.run(root).value,9,'callee queries the original array when its owner becomes ready');
 t.equal(guardCalls,2,'test reaches the static guard and then the refused metadata guard');
 t.equal(reads,1,'metadata refusal never re-evaluates the array getter');
 t.equal(root.meta.importStats.get('abase')||0,0,'refused caller fill performs no query');
 t.equal(leaf.meta.importStats.get('abase'),1,'uncaptured sentinel forces a valid callee query');
 t.end();
});

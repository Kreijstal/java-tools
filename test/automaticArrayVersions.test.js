'use strict';
// Tests a JS or partial-Wasm tier: the closed-world module would take its methods.
process.env.JVM_CLOSED_WORLD = '0';
const test=require('tape');
const {JVM}=require('../src/core/jvm');
const Frame=require('../src/core/frame'),Stack=require('../src/core/callStack');
const {newFields,makeObjectRef,writeField,readField}=require('../src/core/objectModel');
const compile=require('./javaFixture').makeJavaFixtureCompiler('auto-array-version-');

test('bounded array versions run by default and preserve mixed checked accesses',async t=>{
 const classpath=compile(t,'AutoArrayKernels',`
class AutoArrayState {int[] row;int bias;int read(float[] a,int n){int sum=0;for(int i=0;i<n;i++)sum+=(int)a[i&3]+bias;return sum;}}
public class AutoArrayKernels {
 static int plain(float[] a,float[] factors,float[] out,int n){int sum=0;for(int i=0;i<n;i++){
  int p=i&3,q=(p+2)&3;float x=a[p],y=a[q];out[p]=(x-y)*factors[p];out[q]=x+y;sum+=(int)out[p];}return sum;}
 static int ints(int[] a,int n){for(int i=0;i<n;i++){int p=i&3;a[p]=a[p];}return a[0];}
 static long longs(long[] a,int n){for(int i=0;i<n;i++){int p=i&3;a[p]=a[p];}return a[0];}
 static double doubles(double[] a,int n){for(int i=0;i<n;i++){int p=i&3;a[p]=a[p];}return a[0];}
 static int bytes(byte[] a,int n){for(int i=0;i<n;i++){int p=i&3;a[p]=a[p];}return a[0];}
 static int shorts(short[] a,int n){for(int i=0;i<n;i++){int p=i&3;a[p]=a[p];}return a[0];}
 static int chars(char[] a,int n){for(int i=0;i<n;i++){int p=i&3;a[p]=a[p];}return a[0];}
 static long wideHead(long head,float[] a,int n){long sum=head;for(int i=0;i<n;i++)sum+=(long)a[i&3];return sum;}
 static int unbounded(float[] a,float[] out,int j,int n){int sum=0;for(int i=0;i<n;i++){
  int p=i&3;out[p]=a[p]+1;sum+=(int)out[j];}return sum;}
 static int booleans(float[] a,float[] out,boolean[] flags,int n){int sum=0;for(int i=0;i<n;i++){
  int p=i&3;if(flags[p]){out[p]=a[p];sum+=(int)out[p];}}return sum;}
 static int onlyBooleans(boolean[] flags,int n){int sum=0;for(int i=0;i<n;i++)if(flags[i&3])sum++;return sum;}
 static int overflow(float[] a,int index,int n){int sum=0;for(int i=0;i<n;i++)sum+=(int)a[(index+1)&3];return sum;}
 static int wideMask(float[] a,int index,int n){int sum=0;for(int i=0;i<n;i++)sum+=(int)a[index&2147483647];return sum;}
 static int maskByte(float[] a,int n){int sum=0;for(int i=0;i<n;i++)sum+=(int)a[i&63];return sum;}
 static int maskShort(float[] a,int n){int sum=0;for(int i=0;i<n;i++)sum+=(int)a[i&1023];return sum;}
 static int maskPool(float[] a,int n){int sum=0;for(int i=0;i<n;i++)sum+=(int)a[i&65535];return sum;}
 static int literalIndex(float[] a,int n){int sum=0;for(int i=0;i<n;i++)sum+=(int)a[200];return sum;}
 static int signedMask(float[] a,int n){int sum=0;for(int i=0;i<n;i++)sum+=(int)a[i&-2];return sum;}
 static int mixed(AutoArrayState s,float[] a,float[] out,int n){int sum=0;for(int i=0;i<n;i++){
  int p=i&3,v=s.row[p];out[p]=a[p]+v+s.bias;s.bias++;sum+=(int)out[p];}return sum;}
}`);
 const make=async budget=>{
  const j=new JVM({classpath,wasmHeap:true,wasmFields:true,jit:{compileWorker:false,retainCompilerDiagnostics:false,
   wasmStructured:true,wasm:{deepInline:false,canonicalDirectCalls:true,canonicalEhLinks:true,nativeJsExceptionTags:true,
    ...(budget===undefined?{}:{parameterHeapSpecializationMaxBytes:budget})}}});
  await j.preloadClasspathClasses();for(const name of ['AutoArrayState','AutoArrayKernels'])j._markClassInitialized(name);
  const w=j.jit.wasmJit,states={};w.importStatsEnabled=true;
  for(const [name,desc]of Object.entries({plain:'([F[F[FI)I',ints:'([II)I',longs:'([JI)J',doubles:'([DI)D',bytes:'([BI)I',shorts:'([SI)I',chars:'([CI)I',wideHead:'(J[FI)J',unbounded:'([F[FII)I',booleans:'([F[F[ZI)I',onlyBooleans:'([ZI)I',overflow:'([FII)I',wideMask:'([FII)I',maskByte:'([FI)I',maskShort:'([FI)I',maskPool:'([FI)I',literalIndex:'([FI)I',signedMask:'([FI)I',mixed:'(LAutoArrayState;[F[FI)I'})){
   const method=j.findMethod(j.classes.AutoArrayKernels,name,desc),state=w.methodState({method});
   w.compile({method,className:'AutoArrayKernels'},state,{asCallee:true});t.equal(state.status,'ready',state.lastCompileError||name+' compiles');states[name]=state;
  }
  {const method=j.findMethod(j.classes.AutoArrayState,'read','([FI)I'),state=w.methodState({method});
   w.compile({method,className:'AutoArrayState'},state,{asCallee:true});t.equal(state.status,'ready',state.lastCompileError||'instance compiles');states.instance=state;}
  const array=values=>{const a=j.wasmHeap.alloc('[F',values.length);a.type='[F';a.set(values);return a;};
  const object=(row,bias)=>{const s=makeObjectRef(j,'AutoArrayState',newFields(j,'AutoArrayState'));writeField(s.fields,'AutoArrayState.row',row);writeField(s.fields,'AutoArrayState.bias',bias);return s;};
  const run=(name,args)=>{const state=states[name],frame=new Frame(state.method);frame.className=name==='instance'?'AutoArrayState':'AutoArrayKernels';state.meta.paramSlots.forEach(({slot},i)=>frame.locals[slot]=args[i]);
   const thread={id:0,status:'runnable',callStack:new Stack()};thread.callStack.push(frame);return w.execute(frame,thread,state,0).value;};
  return {j,w,states,array,object,run};
 };
 const candidate=await make(),exhausted=await make(1);
 t.equal(candidate.w.parameterHeapSpecializationMaxBytes,4096,'default code accounting remains bounded');
 t.ok(candidate.states.plain.meta.parameterHeapSpecializationBytes>0,'ordinary numeric array loop gets an automatic native version');
 t.ok(candidate.states.mixed.meta.parameterHeapSpecializationBytes>0,'object fields and nonparameter arrays retain their checked lowering inside the version');
 t.equal(candidate.states.plain.meta.parameterHeapBoundsElisionCount,6,'six masked accesses are proved by three entry length guards');
 t.equal(candidate.states.plain.meta.parameterHeapRangeGuardCount,3,'length guards describe each selected native array once');
 t.ok(candidate.states.booleans.meta.parameterHeapSpecializationBytes>0,'checked boolean input does not prevent selecting native float arrays');
 t.equal(candidate.states.onlyBooleans.meta.parameterHeapSpecializationBytes,0,'boolean-only arrays produce no unselectable native body');
 t.equal(candidate.states.wideMask.meta.parameterHeapBoundsElisionCount,0,'a full positive-int mask does not imply any realizable length guard');
 t.equal(exhausted.states.mixed.meta.parameterHeapSpecializationBytes,0,'insufficient code budget retains the original body');
 for(const vm of [candidate,exhausted]){
  const a=vm.array([2,3,1,4]),factors=vm.array([0.5,0.25,1,0.5]),out=vm.array([0,0,0,0]);
  t.equal(vm.run('plain',[a,factors,out,1]),0,'native loop returns the original scalar fold');
  if(vm===candidate)t.equal(vm.states.plain.meta.importStats.get('parameter_heap_native'),1,'actual execution selects the proved native body');t.deepEqual([...out],[0.5,0,3,0],'both stores remain exact');
  t.equal(vm.run('plain',[null,null,null,0]),0,'zero-trip loop keeps unused nulls legal');
  let error;try{vm.run('plain',[null,factors,out,1]);}catch(e){error=e;}t.equal(error?.type,'java/lang/NullPointerException','used null input retains Java exception');
  const short=vm.array([0]);error=undefined;try{vm.run('plain',[a,factors,short,1]);}catch(e){error=e;}
  t.equal(error?.type,'java/lang/ArrayIndexOutOfBoundsException','short native output still checks every index');t.equal(short[0],0.5,'first store precedes failing second store');
  const row=[7];row.type='[I';const object=vm.object(row,3);let gets=0;
  Object.defineProperty(row,0,{get(){gets++;writeField(object.fields,'AutoArrayState.bias',50);return 7;}});
  t.equal(vm.run('mixed',[object,a,out,1]),59,'nonparameter getter effects remain before the later native field read');
  t.equal(gets,1,'getter runs once');t.equal(readField(object.fields,'AutoArrayState.bias'),51,'field update is not replayed');
  gets=0;error=undefined;try{vm.run('mixed',[object,a,out,2]);}catch(e){error=e;}
  t.equal(error?.type,'java/lang/ArrayIndexOutOfBoundsException','foreign row keeps its checked bounds');t.equal(gets,1,'failing row index does not invoke a getter');
  t.equal(readField(object.fields,'AutoArrayState.bias'),51,'earlier field writes survive failure');
 }
 for(const [name,desc,values]of [['ints','[I',[-2147483648,0,1,2147483647]],['longs','[J',[9007199254740993n,-9223372036854775808n,0n,1n]],
  ['doubles','[D',[-0,NaN,Infinity,-Infinity]],['bytes','[B',[-128,127,0,1]],['shorts','[S',[-32768,32767,0,1]],['chars','[C',[65535,0,1,2]]]){
  const array=candidate.j.wasmHeap.alloc(desc,values.length);array.type=desc;array.set(values);
  t.ok(candidate.states[name].meta.parameterHeapBoundsElisionCount>=2,name+' masks and constant access get length proofs');
  t.ok(Object.is(candidate.run(name,[array,4]),values[0]),name+' keeps exact scalar representation');
  for(let i=0;i<4;i++)t.ok(Object.is(array[i],values[i]),name+' keeps element '+i);
 }
 t.equal(candidate.run('wideHead',[9007199254740993n,candidate.array([2,3,1,4]),4]),9007199254741003n,'wide formal slots do not change native parameter selection');
 const instance=candidate.object([],9);
 t.equal(candidate.run('instance',[instance,candidate.array([2,3,1,4]),4]),46,'implicit receiver offset keeps array parameter proof exact');
 t.ok(candidate.states.instance.meta.parameterHeapBoundsElisionCount>0,'instance array accesses use the same range proof');
 for(const [name,length]of [['maskByte',64],['maskShort',1024],['maskPool',65536],['literalIndex',201]]){
  const a=candidate.array(new Float32Array(length).fill(7)),state=candidate.states[name];
  t.equal(state.meta.parameterHeapBoundsElisionCount,1,name+' constant encoding gets the range proof');
  t.equal(state.meta.parameterHeapRangeGuardCount,1,name+' has one entry length guard');
  t.equal(candidate.run(name,[a,4]),28,name+' preserves the loop value');
  t.ok(state.meta.importStats.get('parameter_heap_native')>0,name+' selects the native proof');
  let error;try{candidate.run(name,[candidate.array([7]),length+1]);}catch(e){error=e;}
  t.equal(error?.type,'java/lang/ArrayIndexOutOfBoundsException',name+' short input selects checked bounds');
  t.ok(state.meta.importStats.get('parameter_heap_checked')>0,name+' actually selects the fallback');
 }
 t.equal(candidate.states.signedMask.meta.parameterHeapBoundsElisionCount,0,'negative mask does not establish a nonnegative range');
 const flags=[true,false,true,false];flags.type='[Z';
 const native=candidate.array([2,3,1,4]),mixedOut=candidate.array([0,0,0,0]);
 t.equal(candidate.run('booleans',[native,mixedOut,flags,4]),3,'boolean reads remain checked in a selected native float-array version');
 t.deepEqual([...mixedOut],[2,0,1,0]);
 t.equal(candidate.run('booleans',[null,null,[false,false,false,false],1]),0,'unused null float arrays preserve branch semantics');
 t.equal(candidate.run('onlyBooleans',[flags,4]),2,'boolean-only fallback retains exact values');
 t.equal(candidate.run('overflow',[native,2147483647,1]),2,'mask proof holds after signed addition wraps');
 for(const index of [-1,2147483647]){
  const out=candidate.array([0,0,0,0]);let error;try{candidate.run('unbounded',[native,out,index,1]);}catch(e){error=e;}
  t.equal(error?.type,'java/lang/ArrayIndexOutOfBoundsException','an unproved index stays checked inside the selected native body');
  t.equal(out[0],3,'proved store occurs before a later unproved failure');
 }
 let wideError;try{candidate.run('wideMask',[native,2147483647,1]);}catch(e){wideError=e;}
 t.equal(wideError?.type,'java/lang/ArrayIndexOutOfBoundsException','wide mask keeps its mandatory bounds check');
 // Resume must reselect the proof after the host changes a saved parameter.
 {
  const state=candidate.states.plain,meta=state.meta,frame=new Frame(state.method),carrier=new Frame(state.method);
  const originalOut=candidate.array([0,0,0,0]),replacementOut=candidate.array([99]);
  frame.className='AutoArrayKernels';[native,candidate.array([0.5,0.25,1,0.5]),originalOut,4].forEach((v,i)=>frame.locals[i]=v);
  const thread={id:0,status:'runnable',callStack:new Stack(),pendingException:null};thread.callStack.push(carrier);thread.callStack.push(frame);
  const raw=state.run,handle=candidate.j.handleException,threads=candidate.j.threads,index=candidate.j.currentThreadIndex,enabled=candidate.w.enabled;
  candidate.w.enabled=true;
  const beforeNative=meta.importStats.get('parameter_heap_native')||0,beforeChecked=meta.importStats.get('parameter_heap_checked')||0;
  let changed=false,error,ticks=0;state.run=(...args)=>{args[args.length-1]=2;return raw(...args);};
  candidate.j.threads=[thread];candidate.j.currentThreadIndex=0;
  candidate.j.handleException=(e,pc,th)=>{error=e;th.callStack.pop();};
  try{
   while(thread.callStack.size()>1){
    await candidate.j.executeTick();if(++ticks>1000)throw Error('array-version resume did not progress');
    if(!changed&&candidate.w.hasStructuredResumePoint(frame)){frame.locals[2]=replacementOut;changed=true;}
   }
  }finally{state.run=raw;candidate.j.handleException=handle;candidate.j.threads=threads;candidate.j.currentThreadIndex=index;candidate.w.enabled=enabled;}
  t.ok(changed,'native loop yields through its proved resume header');
  t.equal(error?.type,'java/lang/ArrayIndexOutOfBoundsException','resumed short output re-enters checked execution');
  t.deepEqual([...originalOut],[0.5,0,3,0],'the completed iteration is not replayed');t.equal(replacementOut[0],99,'failed resumed store has no effects');
  t.equal((meta.importStats.get('parameter_heap_native')||0)-beforeNative,1,'first invocation selects native proof');
  t.ok((meta.importStats.get('parameter_heap_checked')||0)>beforeChecked,'resumed invocation revalidates changed length');
 }
 const foreign=exhausted.array([2,3,1,4]),out=candidate.array([0,0,0,0]);
 t.equal(candidate.run('plain',[foreign,candidate.array([0.5,0.25,1,0.5]),out,1]),0,'foreign heap input selects the original mixed-representation body');t.deepEqual([...out],[0.5,0,3,0]);
 const a=candidate.array([2,3,1,4]),row=[7];row.type='[I';const object=candidate.object(row,9);let callbacks=0;
 Object.defineProperty(row,0,{get(){callbacks++;candidate.w.parameterHeapSpecializationMaxBytes=1;
  candidate.w.compile({method:candidate.states.mixed.method,className:'AutoArrayKernels'},candidate.states.mixed,{asCallee:true});return 7;}});
 t.equal(candidate.run('mixed',[object,a,out,1]),18,'active native body returns safely after replacement');t.equal(callbacks,1,'replacement does not repeat the callback');
 t.equal(candidate.states.mixed.meta.parameterHeapSpecializationBytes,0,'the replacement actually uses the budget-refused body');
 if(global.gc){
  candidate.w.parameterHeapSpecializationMaxBytes=4096;const Compiler=require('../src/jit/StructuredWasmCompiler');
  const c=new Compiler(candidate.j,candidate.states.mixed.method,'AutoArrayKernels',candidate.w),lower=c.lowerNode;let graph;
  c.lowerNode=function(...args){graph ||= new WeakRef(this.fn);return lower.apply(this,args);};const meta=c.translateWith(false);
  t.ok(meta.parameterHeapSpecializationBytes>0,'retention fixture contains the mixed native version');
  for(let i=0;i<12;i++){await new Promise(setImmediate);global.gc();}t.equal(graph.deref(),undefined,'installed mixed imports release the SSA graph');
 }
 t.end();
});

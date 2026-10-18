"use strict";
const test=require('tape');
const {JVM}=require('../src/core/jvm');
const Frame=require('../src/core/frame');
const Stack=require('../src/core/callStack');
const {supportsWasmJsTag}=require('../src/jit/wasmShared');
const compile=require('./javaFixture').makeJavaFixtureCompiler('empty-canonical-copy-');
test('bounded empty-effect proof refuses faults, writes, overflow and explosion',t=>{
 const {proveEmptyPrimitiveCopy:prove}=require('../src/jit/emptyPrimitiveCopyProof');
 t.ok(prove([['iload',4],['ifeq',3],['iastore'],['return']]),'unreachable writes are harmless for zero count');
 for(const effect of ['iaload','iastore','getstatic','putstatic','invokestatic','monitorenter','athrow'])
  t.equal(prove([[effect],['return']]),null,'reachable '+effect+' refuses omission');
 t.equal(prove([['iinc',1,1],['return']]),null,'source at INT_MAX may overflow');
 t.equal(prove([['bipush',NaN],['ifeq',3],['iastore'],['return']]),null,'malformed constants cannot discard a path');
 t.equal(prove([['goto',0]]),null,'a zero-effect infinite loop is not a returning invocation');
 t.equal(prove([['iload',3],['ifeq',3],['return'],['iastore']]),null,'all possible destination positions must return without effects');
 t.equal(prove(Array.from({length:2049},()=>['return'])),null,'oversized analysis is refused');
 t.end();
});
const SOURCE=`public class EmptyCopyProof {
 public static void copy(int[] s,int si,int[] d,int di,int n){
  if(s==d){
   if(si==di)return;
   if(di>si && di<si+n){
    n--;si+=n;di+=n;n=si-n;n+=7;
    while(si>=n){
     d[di--]=s[si--];d[di--]=s[si--];d[di--]=s[si--];d[di--]=s[si--];
     d[di--]=s[si--];d[di--]=s[si--];d[di--]=s[si--];d[di--]=s[si--];
    }
    n-=7;while(si>=n)d[di--]=s[si--];return;
   }
  }
  n+=si;n-=7;
  while(si<n){
   d[di++]=s[si++];d[di++]=s[si++];d[di++]=s[si++];d[di++]=s[si++];
   d[di++]=s[si++];d[di++]=s[si++];d[di++]=s[si++];d[di++]=s[si++];
  }
  n+=7;while(si<n)d[di++]=s[si++];
 }
 public static void split(int[] s,int si,int[] d,int di,int n){
  if(s!=d){n=si+n;n-=7;while(si<n){d[di++]=s[si++];}n+=7;while(si<n)d[di++]=s[si++];return;}
  if(si==di)return;
  if(di<=si){n=si+n;n-=7;while(si<n)d[di++]=s[si++];n+=7;while(si<n)d[di++]=s[si++];return;}
  if(di>=si+n){n=si+n;n-=7;while(si<n)d[di++]=s[si++];n+=7;while(si<n)d[di++]=s[si++];return;}
  while(n-->0)d[--di]=s[--si];
 }
 public static int splitCaller(int[] s,int si,int[] d,int di,int n){split(s,si,d,di,n);return 41;}
 public static int root(int[] s,int si,int[] d,int di,int n){try{copy(s,si,d,di,n);return d[0]+d[1];}catch(RuntimeException e){return -97;}}
 public static int caller(int[] s,int si,int[] d,int di,int n){copy(s,si,d,di,n);return 37;}
 public static int effects(int[][] arrays,int[] p){copy(arrays[p[0]++],p[0]++,arrays[p[0]++],p[0]++,p[0]++-4);return p[0];}
}`;
test('empty copies omit native entries while preserving fuel, effects and replacement',async t=>{
 if(!supportsWasmJsTag()){t.pass('engine retains canonical fallback');t.end();return;}
 const classpath=compile(t,'EmptyCopyProof',SOURCE);
 const j=new JVM({classpath,wasmHeap:true,jit:{enabled:false,compileWorker:false,retainCompilerDiagnostics:false,
  wasmStructured:true,wasm:{deepInline:false,canonicalDirectCalls:true,canonicalEhLinks:true,
   canonicalLeafCalls:true,nativeJsExceptionTags:true}}});
 await j.preloadClasspathClasses();j.classInitializationState.set('EmptyCopyProof','INITIALIZED');const w=j.jit.wasmJit;
 const prepare=(name,descriptor='([II[III)V')=>{
  const method=j.findMethod(j.classes.EmptyCopyProof,name,descriptor),st=w.methodState({method});
  w.compile({method,className:'EmptyCopyProof'},st,{asCallee:true});t.equal(st.status,'ready',st.lastCompileError||name+' compiles');return st;
 };
 const copy=prepare('copy'),caller=prepare('caller','([II[III)I'),effects=prepare('effects','([[I[I)I');
 const array=xs=>{const a=j.wasmHeap.alloc('[I',xs.length);a.type='[I';a.set(xs);return a;};
 const execute=async(st,args)=>{
  const frame=new Frame(st.method);frame.className='EmptyCopyProof';args.forEach((x,i)=>frame.locals[i]=x);
  const thread={id:0,status:'runnable',callStack:new Stack()};thread.callStack.push(frame);j.threads=[thread];j.currentThreadIndex=0;
  const result=w.execute(frame,thread,st,0);let value=result.value,steps=0;
  while(!thread.callStack.isEmpty()&&++steps<10000){
   const current=thread.callStack.peek(),ins=current.instructions[current.pc++].instruction;
   if((typeof ins==='string'?ins:ins?.op)==='ireturn')value=current.stack.peek();if(ins)await j.executeInstruction(ins,current,thread);
  }
  t.ok(thread.callStack.isEmpty(),'continuation finishes');return value;
 };
 t.equal(copy.meta.canonicalFuel,copy.meta.hostOwnedCanonicalFuel,'actual callee exports its independent host fuel');
 t.equal(caller.meta.canonicalEmptyCopySites,1,'actual caller contains the omission guard');
 const before=()=>copy.meta.canonicalEntries.value;
 let count=before();
 for(const [s,si,d,di]of [[null,0,null,0],[array([1]),0,array([2]),-1],[null,2147483647,null,-2147483648]]){
  t.equal(await execute(caller,[s,si,d,di,0]),37,'zero count has no array effects');
  t.equal(before(),count,'empty invocation never crosses native function boundary');
 }
 const target=array([0,0]);t.equal(await execute(caller,[array([3,5]),0,target,0,2]),37,'nonempty copy completes');
 t.deepEqual([...target],[3,5],'nonempty copy retains element effects');t.equal(before(),++count,'nonempty copy enters callee');
 const p=array([0]);const refs=Object.assign([null,null,null],{type:'[[I'});
 t.equal(await execute(effects,[refs,p]),5,'argument side effects still execute in order');
 t.equal(p[0],5,'all five argument side effects occur once');
 t.equal(before(),count,'side effects do not prevent omitting the empty call');
 const shortRefs=Object.assign([null,null],{type:'[[I'}),faultProgress=array([0]);
 let fault;
 try{await execute(effects,[shortRefs,faultProgress]);}catch(error){fault=error;}
 t.equal(fault?.type,'java/lang/ArrayIndexOutOfBoundsException','throwing argument is evaluated before any empty-call guard');
 t.equal(faultProgress[0],3,'argument failure preserves exactly the preceding effects');
 t.equal(before(),count,'argument failure never invokes the callee');
 for(const fuel of [1,2,3]){
  Object.getOwnPropertyDescriptor(WebAssembly.Global.prototype,'value').set.call(copy.meta.canonicalFuel,fuel);
  const previous=before();t.equal(await execute(caller,[null,0,null,0,0]),37,'fuel '+fuel+' preserves completion');
  t.equal(before(),previous+(fuel<=2?1:0),'fuel '+fuel+' chooses the correct native path');
 }
 copy.meta.canonicalFuel.value=100000000;
 const oldFuel=copy.meta.hostOwnedCanonicalFuel,oldMeta=new WeakRef(copy.meta),oldOwner=new WeakRef(copy.meta.directFrameContext);
 prepare('copy');count=before();
 t.equal(await execute(caller,[null,0,null,0,0]),37,'old caller reaches replacement');
 t.equal(before(),count+1,'replacement revokes the old fuel guard');
 oldFuel.value=1;count=before();
 t.equal(await execute(caller,[null,0,null,0,0]),37,'retired fuel changes cannot alter replacement');
 t.equal(before(),count+1,'replacement continues through its current native entry');
 // A dispatcher companion can retain old direct imports. Refresh the callers
 // before checking runtime metadata ownership, then keep an imported old fuel
 // in a separate native reader (covered independently in the assembler test).
 prepare('caller','([II[III)I');prepare('effects','([[I[I)I');
 if(global.gc){for(let i=0;i<10;i++){await new Promise(setImmediate);global.gc();}
  t.equal(oldMeta.deref(),undefined,'retired metadata collects');t.equal(oldOwner.deref(),undefined,'retired frame owner collects');}
 const split=prepare('split'),splitCaller=prepare('splitCaller','([II[III)I');
 t.equal(split.meta.primitiveCopyEntryUnroll,0,'duplicated branches are not a whole-copy template match');
 t.ok(split.meta.primitiveCopyZeroProof,'bounded proof accepts duplicated zero-effect paths');
 t.equal(splitCaller.meta.canonicalEmptyCopySites,1,'duplicated branches authorize actual caller omission');
 t.equal(await execute(splitCaller,[null,2147483647,null,-2147483648,0]),41,'duplicated method handles extreme source position');
 t.equal(split.meta.canonicalEntries.value,0,'duplicated empty method is never entered');
 const splitTarget=array([0]);t.equal(await execute(splitCaller,[array([19]),0,splitTarget,0,1]),41,'duplicated nonempty method runs');
 t.equal(splitTarget[0],19,'duplicated nonempty effect is preserved');
 const slots=caller.meta.canonicalSlots,guard=w.canonicalDirectLinks.bySlot.get(slots[0]).emptyCopy;
 t.equal(guard.heap.i32[guard.address>>2],1,'current guard is published');
 j.classInitializationState.set('EmptyCopyProof','ERRONEOUS');
 const coldFrame=new Frame(caller.method);caller.meta.box.frame=coldFrame;
 try{t.ok(caller.run(null,0,null,0,0,0,100000000)>=0,'cold callee preserves the invocation exit rather than omitting it');}
 finally{caller.meta.box.frame=null;j.classInitializationState.set('EmptyCopyProof','INITIALIZED');}
 w.canonicalDirectLinks.withdraw(copy.key);t.equal(guard.heap.i32[guard.address>>2],0,'withdrawal revokes omission immediately');
 w.canonicalDirectLinks.publish(copy);t.equal(guard.heap.i32[guard.address>>2],1,'compatible republishing restores omission');
 w.canonicalDirectLinks.release(slots);t.equal(w.canonicalDirectLinks.bySlot.has(slots[0]),false,'retirement removes binding');
 const recycled=j.wasmHeap.allocObject(8);t.equal(recycled,guard.address,'guard storage is reclaimed with its binding');
 j.wasmHeap.free(recycled,8);
 const allocate=j.wasmHeap.allocObject;j.wasmHeap.allocObject=()=>-1;
 try{prepare('caller','([II[III)I');t.equal(caller.meta.canonicalEmptyCopySites,0,'allocation failure retains the native call');}
 finally{j.wasmHeap.allocObject=allocate;}
 count=before();t.equal(await execute(caller,[null,0,null,0,0]),37,'allocation fallback completes');
 t.equal(before(),count+1,'allocation fallback actually enters the callee');
 const token=j.getClassInitializationToken('EmptyCopyProof');token.wasmReadinessGuard=()=>()=>1;
 prepare('copy');prepare('caller','([II[III)I');
 t.equal(caller.meta.canonicalEmptyCopySites,0,'custom readiness retains its supported invocation checks');
 t.end();
});

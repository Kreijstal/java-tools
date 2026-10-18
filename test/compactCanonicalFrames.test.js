'use strict';
const test=require('tape');
const {CanonicalDirectLinks,DirectFrameContext}=require('../src/jit/CanonicalDirectFrames');
const {T,OP,sleb,STRUCTURED_RETURN,CAPTURE_DIRECT_ID,assembleModule,supportsWasmTryTable}=require('../src/jit/wasmShared');

test('compact assembler exports preserve legacy entries and scalar return types',t=>{
 if(!supportsWasmTryTable()){t.pass('engine keeps existing entries');t.end();return;}
 for(const type of [null,T.i32,T.i64,T.f32,T.f64]){
  let ready=true;const owner={},ret=type===T.i64?17n:17;
  const value=type===T.i64?[OP.i64_const,...sleb(17)]:type===T.f32?[OP.f32_const,0,0,136,65]:
    type===T.f64?[OP.f64_const,0,0,0,0,0,0,49,64]:[OP.i32_const,17];
  const body=[CAPTURE_DIRECT_ID,...(type?[...value,OP.global_set,0]:[])];
  body.push(OP.i32_const,...sleb(-1),STRUCTURED_RETURN,OP.end);
  const bytes=assembleModule({importDecls:[{name:'ready',params:[],results:[T.i32]}],
   mainParams:[T.ref,T.i32,T.i32,T.i32,T.i32],mainResults:[T.i32],declared:[T.i32],body,
   retvType:type,runvWrapper:true,parameterArrayABI:[0],canonicalFrameExport:{readyIdx:0,compact:true,inlineCompact:true,idLocal:5}});
  const x=new WebAssembly.Instance(new WebAssembly.Module(bytes),{env:{ready:()=>ready?1:0}}).exports;
  x.canonicalOwner.value=owner;
  t.equal(x.canonicalInlineCompactRun,x.canonicalCompactRun,'ordinary compact entry contains the body');
  t.equal(x.canonicalInlineCompactHeapRun,x.canonicalCompactHeapRun,'expanded compact entry contains the body');
  const legacy=x.canonicalRun(null);t.deepEqual(legacy,[-1,1,owner,...(type?[ret]:[])],'legacy canonical ABI is unchanged');
  const compact=x.canonicalCompactRun(null);t.deepEqual(type?compact:[compact],[-1,...(type?[ret]:[])],'compact entry returns only status/value');
  const expanded=x.canonicalCompactHeapRun(null,-1,0);t.deepEqual(type?expanded:[expanded],[-1,...(type?[ret]:[])],'expanded metadata keeps the compact result ABI');
  t.equal(x.canonicalEntries.value,3,'normal invocation accounting includes every entry');
  ready=false;const refused=x.canonicalCompactHeapRun(null,-1,0);
  t.deepEqual(type?refused:[refused],[-4,...(type?[type===T.i64?0n:0]:[])],'cold compact entry refuses before its body');
  t.equal(x.canonicalEntries.value,3,'cold refusal does not allocate invocation ids');
  ready=true;x.canonicalEntries.value=-1;x.canonicalCompactRun(null);
  t.equal(x.canonicalEntries.value,1,'counter wrap still skips reserved invocation zero');
 }
 t.end();
});

test('inline compact entries preserve local indices and bound duplicated code',t=>{
 if(!supportsWasmTryTable()){t.pass('engine retains wrapper entries');t.end();return;}
 const observed=[];
 const make=padding=>{
  const body=[CAPTURE_DIRECT_ID,...Array(padding).fill(0x01)]; // wasm nop
  for(let i=1;i<=5;i++)body.push(OP.local_get,i);
  body.push(OP.call,1,OP.i32_const,15,OP.global_set,0,
   OP.i32_const,...sleb(-1),STRUCTURED_RETURN,OP.end);
  return new WebAssembly.Instance(new WebAssembly.Module(assembleModule({
   importDecls:[{name:'ready',params:[],results:[T.i32]},
    {name:'capture',params:Array(5).fill(T.i32),results:[]}],
   mainParams:[T.ref,T.i32,T.i32,T.i32,T.i32],mainResults:[T.i32],declared:[T.i32],body,
   retvType:T.i32,runvWrapper:true,parameterArrayABI:[0],
   canonicalFrameExport:{readyIdx:0,compact:true,inlineCompact:true,idLocal:5}})),
   {env:{ready:()=>1,capture:(...args)=>observed.push(args)}}).exports;
 };
 const x=make(0),owner={};x.canonicalOwner.value=owner;x.canonicalFuel.value=29;
 t.equal(x.run(null,8,17),-1,'public main ABI remains unchanged');
 t.deepEqual(observed.pop(),[-2,0,8,17,0],'plain entry keeps metadata, block, fuel and zero id');
 t.deepEqual(x.canonicalCompactRun(null),[-1,15],'opcode-valued immediate remains a literal');
 t.deepEqual(observed.pop(),[-2,0,0,29,1],'ordinary compact entry initializes missing metadata');
 t.deepEqual(x.canonicalCompactHeapRun(null,48,7),[-1,15],'expanded entry returns its body value');
 t.deepEqual(observed.pop(),[48,7,0,29,2],'expanded entry preserves forwarded metadata indices');
 t.deepEqual(x.canonicalRun(null),[-1,3,owner,15],'legacy entry preserves owner/id results');
 t.deepEqual(observed.pop(),[-2,0,0,29,3],'legacy entry still captures and clears invocation id');
 const large=make(17000);
 t.equal(large.canonicalInlineCompactRun,undefined,'large ordinary body retains wrapper');
 t.equal(large.canonicalInlineCompactHeapRun,undefined,'large expanded body retains wrapper');
 t.deepEqual(large.canonicalCompactHeapRun(null,64,9),[-1,15],'budget fallback remains executable');
 t.deepEqual(observed.pop(),[64,9,0,100000000,1],'budget fallback captures the same local layout');
 const one=make(8500);
 t.equal(one.canonicalInlineCompactHeapRun,one.canonicalCompactHeapRun,'forwarded entry receives budget first');
 t.equal(one.canonicalInlineCompactRun,undefined,'combined duplication stays under the shared budget');
 t.deepEqual(one.canonicalCompactRun(null),[-1,15],'second entry keeps executable wrapper');
 t.end();
});

test('compact slots retain legacy fallbacks, publication identity and retirement',t=>{
 const links=new CanonicalDirectLinks(),calls=[];
 const fallback=n=>{calls.push(n);return n+7;};
 const slot=links.allocate('Compact.value(I)I',[T.i32],[T.i32],fallback,[],true);
 t.deepEqual(links.table.get(slot)(3),[-6,10],'compact stub runs bridge once without unused results');
 const bytes=assembleModule({importDecls:[],mainParams:[T.i32],mainResults:[T.i32,T.i32],declared:[],
  body:[OP.i32_const,...sleb(-1),OP.local_get,0,OP.end]});
 const native=new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports.run;
 const state={key:'Compact.value(I)I',status:'ready',meta:{canonicalRun:()=>{},canonicalCompactRun:native,
  canonicalCompactOwnerTag:links.identity,normalFlowFullyCompiled:true,nativeJsExceptionTags:true,
  retChar:'I',paramSlots:[{slot:0,t:T.i32}]}};
 links.publish(state);t.deepEqual(links.table.get(slot)(5),[-1,5],'eligible native compact entry publishes');
 t.deepEqual(calls,[3],'native success never calls the bridge');
 links.publish({...state,meta:{...state.meta,canonicalCompactOwnerTag:Symbol('foreign')}});
 t.deepEqual(links.table.get(slot)(9),[-6,16],'foreign exit manager cannot serve this compact slot');
 links.publish({...state,meta:{...state.meta,canonicalCompactRun:null}});
 t.deepEqual(links.table.get(slot)(11),[-6,18],'missing compact export keeps the legacy bridge');
 links.publish(state);links.withdraw(state.key);t.deepEqual(links.table.get(slot)(13),[-6,20],'withdrawal restores bridge immediately');
 links.release([slot]);t.equal(links.table.get(slot),null,'retirement releases target');
 t.equal(links.allocate('Other.value(I)I',[T.i32],[T.i32],fallback,[],true),slot,'retired slot is reused');
 t.end();
});

test('exit transfer identifies recursive owners and never strongly retains a retired owner',async t=>{
 const links=new CanonicalDirectLinks(),a={},b={};
 links.publishExit(a,7,12);links.publishExit(b,9,24);
 t.deepEqual(links.takeExit(24),{owner:b,id:9},'most recently returning callee owns immediate transfer');
 t.equal(links.pendingExit,null,'take clears channel before any continuation can reenter');
 links.publishExit(a,7,12);t.deepEqual(links.takeExit(12),{owner:a,id:7},'outer exit republishes its own id after nested handoff');
 links.publishExit(a,-2147483648,12);t.deepEqual(links.takeExit(12),{owner:a,id:-2147483648},'wrapped nonzero ids preserve signed identity');
 links.publishExit(b,0,-5);t.deepEqual(links.takeExit(-5),{owner:b,id:0},'unhandled exception transfers exact owner without a fabricated frame');
 t.throws(()=>links.takeExit(12),/exact owner/,'absent channel is refused');
 links.publishExit(a,7,12);t.throws(()=>links.takeExit(24),/exact owner/,'mismatched exit status cannot consume stale metadata');
 t.equal(links.pendingExit,null,'refusal also clears stale channel');
 if(global.gc){
  const create=()=>{const owner={retired:true};links.publishExit(owner,19,32);return new WeakRef(owner);};
  const retired=create();for(let i=0;i<8;i++){await new Promise(setImmediate);global.gc();}
  t.equal(retired.deref(),undefined,'unconsumed legacy/retired exit owns no strong reference');
  t.throws(()=>links.takeExit(32),/exact owner/,'collected owner is never replaced with the current target');
 }
 t.end();
});

test('installed compact calls preserve recursion, active replacement, exceptions and fuel ownership',async t=>{
 const {supportsWasmJsTag}=require('../src/jit/wasmShared');
 if(!supportsWasmJsTag()){t.pass('older engine retains legacy calls');t.end();return;}
 const {JVM}=require('../src/core/jvm'),Frame=require('../src/core/frame'),Stack=require('../src/core/callStack');
 const compile=require('./javaFixture').makeJavaFixtureCompiler('compact-frame-proof-');
 const classpath=compile(t,'CompactFrameProof',`public class CompactFrameProof {
  static int leaf(int[] a,int n,int[] p){int sum=0;try{for(int i=0;i<n;i++){sum+=a[i];p[0]++;}}
   catch(ArrayIndexOutOfBoundsException e){p[1]=sum;return -31;}return sum;}
  static int caller(int[] a,int n,int[] p){return leaf(a,n,p)+5;}
  static int recursive(int[] a,int n,int[] p){if(n==0)return leaf(a,3,p);return recursive(a,n-1,p)+1;}
 }`);
 const j=new JVM({classpath,wasmHeap:true,jit:{enabled:false,compileWorker:false,retainCompilerDiagnostics:false,
  wasmStructured:true,wasm:{deepInline:false,canonicalDirectCalls:true,canonicalEhLinks:true,canonicalLeafCalls:true,nativeJsExceptionTags:true}}});
 await j.preloadClasspathClasses();j.classInitializationState.set('CompactFrameProof','INITIALIZED');const w=j.jit.wasmJit;
 const prepare=name=>{const method=j.findMethod(j.classes.CompactFrameProof,name,'([II[I)I'),state=w.methodState({method});
  w.compile({method,className:'CompactFrameProof'},state,{asCallee:true});t.equal(state.status,'ready',state.lastCompileError||name+' compiles');return state;};
 const leaf=prepare('leaf'),caller=prepare('caller'),recursive=prepare('recursive');
 t.ok(caller.meta.canonicalCompactSites>0,'actual caller uses compact native slots');
 t.ok(leaf.meta.canonicalCompactHeapRun,'callee exports compact forwarded-array entry');
 t.ok(leaf.meta.canonicalInlineCompactHeapRun,'actual native callee inlines its compact entry');
 const array=values=>{const a=j.wasmHeap.alloc('[I',values.length);a.type='[I';a.set(values);return a;};
 const execute=async(state,a,n,p)=>{const frame=new Frame(state.method);frame.className='CompactFrameProof';frame.locals[0]=a;frame.locals[1]=n;frame.locals[2]=p;
  const thread={id:0,status:'runnable',callStack:new Stack()};thread.callStack.push(frame);j.threads=[thread];j.currentThreadIndex=0;
  const result=w.execute(frame,thread,state,0);let value=result.value,steps=0;
  while(!thread.callStack.isEmpty()&&++steps<10000){const current=thread.callStack.peek(),ins=current.instructions[current.pc++].instruction;
   if((typeof ins==='string'?ins:ins?.op)==='ireturn')value=current.stack.peek();if(ins)await j.executeInstruction(ins,current,thread);}
  t.ok(thread.callStack.isEmpty(),'continuation finishes without replay loop');
  t.equal(leaf.meta.directFrameContext.frames.size,0,'leaf releases transferred frames');return value;};
 let p=array([0,0]);t.equal(await execute(caller,array([2,3,5]),3,p),15,'normal call has exact value');
 t.deepEqual([...p],[3,0],'normal effects occur once');t.equal(leaf.meta.directFrameContext.createdFrames,0,'normal compact entry creates no frame');
 t.equal(w.canonicalDirectLinks.pendingExit,null,'normal calls publish no ownership record');
 p=array([0,0]);t.equal(await execute(caller,array([2,3]),3,p),-26,'caught failure owns exact continuation');
 t.deepEqual([...p],[2,5],'handler observes exact partial effects');
 leaf.meta.canonicalFuel.value=1;p=array([0,0]);t.equal(await execute(caller,array([2,3,5]),3,p),15,'low-fuel exit resumes exact locals');
 t.deepEqual([...p],[3,0],'fuel handoff never replays earlier effects');leaf.meta.canonicalFuel.value=100000000;
 p=array([0,0]);t.equal(await execute(recursive,array([2,3]),3,p),-28,'recursive compact calls keep independent owner ids');
 t.deepEqual([...p],[2,5],'recursive handler preserves locals');
 const old=leaf.meta;let replacements=0;const plain=Object.assign([2,7],{type:'[I'});
 Object.defineProperty(plain,1,{get(){
  const nested=old.canonicalRun(array([11]),2,array([0,0]));
  t.equal(nested[0],-3,'host callback can recursively produce a legacy owned exit');
  nested[2].take(nested[1]);
  replacements++;prepare('leaf');throw {type:'java/lang/ArrayIndexOutOfBoundsException'};
 }});
 p=array([0,0]);t.equal(await execute(caller,plain,2,p),-26,'active old callee owns its exit after replacement');
 t.deepEqual([...p],[1,2],'replacement never replays throwing read or earlier effects');
 t.equal(replacements,1,'replacement occurs exactly once');t.notEqual(leaf.meta,old,'replacement was actually installed');
 t.equal(old.directFrameContext.frames.size,0,'retired old owner releases its frame');
 const heap=leaf.meta.canonicalCompactHeapRun;leaf.meta.canonicalCompactHeapRun=null;w.canonicalDirectLinks.publish(leaf);
 p=array([0,0]);t.equal(await execute(caller,array([11,13]),2,p),29,'unavailable compact export retains supported bridge');
 leaf.meta.canonicalCompactHeapRun=heap;w.canonicalDirectLinks.publish(leaf);
 const older=new JVM({classpath,wasmHeap:true,jit:{enabled:false,compileWorker:false,wasmStructured:true,
  wasm:{deepInline:false,canonicalDirectCalls:true,canonicalEhLinks:true,canonicalLeafCalls:true,nativeJsExceptionTags:false}}});
 await older.preloadClasspathClasses();older.classInitializationState.set('CompactFrameProof','INITIALIZED');
 const legacy=name=>{const method=older.findMethod(older.classes.CompactFrameProof,name,'([II[I)I'),state=older.jit.wasmJit.methodState({method});
  older.jit.wasmJit.compile({method,className:'CompactFrameProof'},state,{asCallee:true});
  t.equal(state.status,'ready',state.lastCompileError||'legacy '+name+' compiles');return state;};
 const oldLeaf=legacy('leaf'),oldCaller=legacy('caller');
 t.equal(oldLeaf.meta.canonicalCompactRun,null,'unsupported payload capture emits no compact entry');
 t.equal(oldCaller.meta.canonicalCompactSites,0,'older path keeps canonical result protocol');
 t.ok(oldCaller.meta.canonicalDirectSites>0,'older fixture still uses native canonical calls');
 const values=older.wasmHeap.alloc('[I',2);values.type='[I';values.set([2,3]);
 const progress=older.wasmHeap.alloc('[I',2);progress.type='[I';
 const frame=new Frame(oldCaller.method);oldCaller.meta.box.frame=frame;
 try{t.equal(oldCaller.run(values,2,progress,0,100000),-1,'legacy caller completes');
  t.equal(oldCaller.meta.box.ret,10,'legacy result is exact');}
 finally{oldCaller.meta.box.frame=null;}
 t.end();
});

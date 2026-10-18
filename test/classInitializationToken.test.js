'use strict';
const test = require('tape');
const {JVM} = require('../src/core/jvm');
const ClassInitializationToken = require('../src/core/ClassInitializationToken');
const {WasmHeap}=require('../src/core/wasmHeap');

test('heap readiness words follow state changes and refreshed heap views',t=>{
 const j=new JVM({jit:{compileWorker:false}}),token=j.getClassInitializationToken('WordProbe');
 const a=new WasmHeap(2,1),b=new WasmHeap(1);
 const first=token.wasmReadinessAddress(a),second=token.wasmReadinessAddress(b);
 t.ok(first>=8&&first%8===0,'word gets an aligned persistent allocation');
 t.equal(token.wasmReadinessAddress(a),first,'repeated preparation reuses the same cell');
 const guard=token.wasmReadinessGuard();
 for(const state of ['INITIALIZING','INITIALIZED','ERRONEOUS','INITIALIZED']){
  j.classInitializationState.set('WordProbe',state);
  const expected=state==='INITIALIZED'?1:0;
  t.equal(a.i32[first>>>2],expected,'first heap follows '+state);
  t.equal(b.i32[second>>>2],expected,'second heap follows '+state);
  t.equal(guard(),expected,'old native getter agrees with heap words');
 }
 const old=a.i32;
 t.equal(a.growTo(1024*1024+65536),true,'heap without guest array views can grow');
 t.equal(old.length,0,'old view actually detached');
 j.classInitializationState.delete('WordProbe');
 t.equal(a.i32[first>>>2],0,'deletion writes through the refreshed view');
 t.equal(b.i32[second>>>2],0,'deletion invalidates every heap word');
 token.initialized=true;j.classInitializationState.clear();
 t.equal(a.i32[first>>>2],0,'clear invalidates existing words');
 token.initialized=true;j._refreshClassInitializationTokens();
 t.equal(a.i32[first>>>2],0,'state refresh invalidates existing words');
 t.end();
});

test('custom guards and exhausted heaps retain callable readiness',t=>{
 const heap=new WasmHeap(1),token=new ClassInitializationToken('INITIALIZED');
 const before=heap.top;let calls=0;
 token.wasmReadinessGuard=()=>()=>{calls++;return 0;};
 t.equal(token.wasmReadinessAddress(heap),undefined,'custom guard refuses a heap shortcut');
 t.equal(heap.top,before,'refusal allocates no cell');
 t.equal(token.wasmReadinessGuard()(),0,'custom behavior remains callable');
 t.equal(calls,1,'custom guard is not bypassed');
 const full=new WasmHeap(1);full.allocObject(full.limit-full.top);
 const ordinary=new ClassInitializationToken('INITIALIZED');
 t.equal(ordinary.wasmReadinessAddress(full),undefined,'spent heap refuses inline readiness');
 const guard=ordinary.wasmReadinessGuard();t.equal(guard(),1,'spent heap keeps existing warm getter');
 ordinary.initialized=false;t.equal(guard(),0,'fallback getter keeps live resets');
 t.end();
});

test('readiness tokens do not retain abandoned heaps',async t=>{
 if(!global.gc){t.pass('run with --expose-gc for heap lifetime coverage');t.end();return;}
 const token=new ClassInitializationToken('INITIALIZED');
 const create=()=>{const heap=new WasmHeap(1);token.wasmReadinessAddress(heap);
  return [new WeakRef(heap),new WeakRef(heap.memory)];};
 const refs=[...create(),...create()];
 for(let i=0;i<8;i++){await new Promise(setImmediate);global.gc();}
 t.deepEqual(refs.map(ref=>ref.deref()===undefined),[true,true,true,true],'token owns no strong heap or memory references');
 token.initialized=false;
 t.equal(token._heapReadiness.length,0,'state update prunes dead weak entries');
 t.end();
});

test('live imported memories keep readiness updates after their heap wrapper dies',async t=>{
 if(!global.gc){t.pass('run with --expose-gc for heap lifetime coverage');t.end();return;}
 const token=new ClassInitializationToken('INITIALIZED');
 const create=()=>{const heap=new WasmHeap(1),address=token.wasmReadinessAddress(heap);
  return {heap:new WeakRef(heap),memory:heap.memory,address};};
 const retained=create();
 for(let i=0;i<8;i++){await new Promise(setImmediate);global.gc();}
 t.equal(retained.heap.deref()===undefined,true,'the memory owner is independent of its heap wrapper');
 token.initialized=false;
 t.equal(new Int32Array(retained.memory.buffer,retained.address,1)[0],0,'live old memory observes a reset');
 token.initialized=true;
 t.equal(new Int32Array(retained.memory.buffer,retained.address,1)[0],1,'live old memory observes readiness again');
 t.end();
});

test('canonical wrappers read heap readiness without importing a getter',t=>{
 const {T,OP,sleb,assembleModule,supportsWasmTryTable}=require('../src/jit/wasmShared');
 if(!supportsWasmTryTable()){t.pass('engine retains its existing entry');t.end();return;}
 const heap=new WasmHeap(1),token=new ClassInitializationToken('UNINITIALIZED');
 const address=token.wasmReadinessAddress(heap),owner={name:'owner'};
 const bytes=assembleModule({importDecls:[],mainParams:[T.ref,T.i32,T.i32,T.i32,T.i32],
  mainResults:[T.i32],declared:[],body:[OP.i32_const,...sleb(-1),OP.end],
  importMemory:true,runvWrapper:true,parameterArrayABI:[0],canonicalFrameExport:{readyAddress:address}});
 const module=new WebAssembly.Module(bytes),x=new WebAssembly.Instance(module,{env:{mem:heap.memory}}).exports;
 x.canonicalOwner.value=owner;
 t.deepEqual(WebAssembly.Module.imports(module).map(i=>i.kind),['memory'],'wrapper imports memory only');
 t.deepEqual(x.canonicalRun(null),[-4,0,null],'cold ordinary canonical entry refuses before work');
 t.deepEqual(x.canonicalHeapRun(null,-1,0),[-4,0,null],'cold expanded entry uses the same guard');
 t.equal(x.canonicalEntries.value,0,'cold refusal precedes invocation accounting');
 token.initialized=true;
 t.deepEqual(x.canonicalRun(null),[-1,1,owner],'warm ordinary entry keeps canonical ABI');
 t.deepEqual(x.canonicalHeapRun(null,-1,0),[-1,2,owner],'warm expanded entry keeps canonical ABI');
 token.initialized=false;
 t.deepEqual(x.canonicalHeapRun(null,-1,0),[-4,0,null],'compiled wrapper observes readiness reset');
 const build=readyAddress=>assembleModule({importDecls:[],mainParams:[T.i32,T.i32],mainResults:[T.i32],
  declared:[],body:[OP.i32_const,...sleb(-1),OP.end],importMemory:true,runvWrapper:true,
  canonicalFrameExport:{readyAddress}});
 for(const invalid of [-1,2,NaN,8.5,0x80000000])
  t.throws(()=>build(invalid),/aligned imported memory/,'invalid address is refused');
 t.throws(()=>assembleModule({importDecls:[],mainParams:[],mainResults:[],declared:[],body:[OP.end],
  canonicalFrameExport:{readyAddress:address}}),/aligned imported memory/,'missing memory import is refused');
 t.end();
});

test('compiled scalar canonical entries use live words and preserve custom guard fallback',async t=>{
 const {supportsWasmTryTable}=require('../src/jit/wasmShared');
 if(!supportsWasmTryTable()){t.pass('engine retains existing entry');t.end();return;}
 const compile=require('./javaFixture').makeJavaFixtureCompiler('inline-owner-readiness-');
 const classpath=compile(t,'OwnerReadinessProof','public class OwnerReadinessProof {static int add(int x){return x+7;}}');
 const j=new JVM({classpath,wasmHeap:true,jit:{enabled:false,compileWorker:false,
  retainCompilerDiagnostics:false,wasmStructured:true,wasm:{canonicalDirectCalls:true,
   canonicalEhLinks:true,canonicalLeafCalls:true,nativeJsExceptionTags:true}}});
 await j.preloadClasspathClasses();
 const method=j.findMethod(j.classes.OwnerReadinessProof,'add','(I)I'),w=j.jit.wasmJit,st=w.methodState({method});
 const prepare=()=>{w.compile({method,className:'OwnerReadinessProof'},st,{asCallee:true});
  t.equal(st.status,'ready',st.lastCompileError||'scalar body compiles');return st.meta;};
 const meta=prepare();
 t.equal(Object.hasOwn(meta.importObject.env,'canonical_owner_ready'),false,'default entry imports no readiness function');
 t.equal(meta.importObject.env.mem,j.wasmHeap.memory,'pure scalar body binds the readiness memory');
 t.deepEqual(meta.canonicalRun(5),[-4,0,null,0],'preparation does not initialize its cold owner');
 j.classInitializationState.set('OwnerReadinessProof','INITIALIZED');
 const warm=meta.canonicalRun(5);
 t.equal(warm[0],-1,'initialized owner permits entry');t.equal(warm[3],12,'ordinary scalar result is exact');
 j.classInitializationState.set('OwnerReadinessProof','ERRONEOUS');
 t.deepEqual(meta.canonicalRun(5),[-4,0,null,0],'already compiled entry observes erroneous state');
 t.equal(meta.canonicalEntries.value,1,'refused entries never allocate an invocation');
 t.equal(meta.directFrameContext.createdFrames,0,'readiness and ordinary returns fabricate no frame');
 j.classInitializationState.set('OwnerReadinessProof','INITIALIZED');
 const token=j.getClassInitializationToken('OwnerReadinessProof');let allowed=true,calls=0;
 token.wasmReadinessGuard=()=>()=>{calls++;return allowed?1:0;};
 const custom=prepare();
 t.equal(typeof custom.importObject.env.canonical_owner_ready,'function','replacement keeps custom readiness callable');
 t.equal(Object.hasOwn(custom.importObject.env,'mem'),false,'custom scalar entry needs no readiness memory');
 t.equal(custom.canonicalRun(6)[3],13,'custom warm entry keeps the numeric ABI');
 allowed=false;t.deepEqual(custom.canonicalRun(6),[-4,0,null,0],'custom cold response is not bypassed');
 t.equal(calls,2,'custom hook is called exactly once per entry');
 t.end();
});

test('structured dependency words preserve untaken initialization and custom dependency guards',async t=>{
 const {supportsWasmTryTable,getOp}=require('../src/jit/wasmShared');
 if(!supportsWasmTryTable()){t.pass('engine retains existing entry');t.end();return;}
 const compile=require('./javaFixture').makeJavaFixtureCompiler('dependency-readiness-');
 const classpath=compile(t,'DependencyWordProof',`public class DependencyWordProof {
  static int read(int[] a,int n){int s=0;for(int i=0;i<n;i++)s+=a[i]+ColdWordDependency.value;return s;}
 }class ColdWordDependency {static int value=5;}`);
 const Frame=require('../src/core/frame'),Stack=require('../src/core/callStack');
 const j=new JVM({classpath,wasmHeap:true,jit:{enabled:false,compileWorker:false,
  retainCompilerDiagnostics:false,wasmStructured:true,wasm:{canonicalDirectCalls:true,
   canonicalEhLinks:true,canonicalLeafCalls:true,nativeJsExceptionTags:true}}});
 await j.preloadClasspathClasses();j.classInitializationState.set('DependencyWordProof','INITIALIZED');
 const method=j.findMethod(j.classes.DependencyWordProof,'read','([II)I'),w=j.jit.wasmJit,st=w.methodState({method});
 const prepare=()=>{w.compile({method,className:'DependencyWordProof'},st,{asCallee:true});
  t.equal(st.status,'ready',st.lastCompileError||'dependency body compiles');return st.meta;};
 const meta=prepare();
 t.equal(meta.heapReadinessGuardCount,1,'cold static dependency uses an inline word');
 t.equal(Object.hasOwn(meta.importObject.env,'static_ready_ColdWordDependency'),false,'dependency getter call is absent');
 const frame=new Frame(method);frame.className='DependencyWordProof';frame.locals[0]=null;frame.locals[1]=0;
 const thread={id:0,status:'runnable',callStack:new Stack()};thread.callStack.push(frame);
 j.threads=[thread];j.currentThreadIndex=0;w.execute(frame,thread,st,0);
 t.equal(frame.pc,0,'cold word returns to the original entry');
 let value,steps=0;
 while(!thread.callStack.isEmpty()&&++steps<100){
  const f=thread.callStack.peek(),ins=f.instructions[f.pc++].instruction;
  if(getOp(ins)==='ireturn')value=f.stack.peek();
  if(ins)await j.executeInstruction(ins,f,thread);
 }
 t.equal(value,0,'untaken loop completes through the ordinary continuation');
 t.notEqual(j.classInitializationState.get('ColdWordDependency'),'INITIALIZED','untaken access never initializes its owner');
 const fields=j.classes.ColdWordDependency.staticFields;
 t.equal(fields.has('value:I'),false,'cold refusal runs no initializer or static write');
 fields.set('value:I',5);j.classInitializationState.set('ColdWordDependency','INITIALIZED');
 const array=j.wasmHeap.alloc('[I',2);array.type='[I';array.set([2,3]);
 t.equal(meta.canonicalRun(array,2)[3],15,'same compiled body runs after dependency initialization');
 let reads=0;
 Object.defineProperty(fields.cell('value:I'),'value',{configurable:true,get(){reads++;return 5;}});
 j.classInitializationState.set('ColdWordDependency','ERRONEOUS');
 const refused=meta.canonicalRun(array,2);
 t.equal(refused[0],0,'existing dependency word observes a reset');
 t.equal(refused[2].take(refused[1]).pc,0,'owned reset continuation retains its original PC');
 t.equal(reads,0,'cold dependency refuses before the field accessor');
 let checks=0;
 j.getClassInitializationToken('ColdWordDependency').wasmReadinessGuard=()=>()=>{checks++;return 0;};
 const custom=prepare(),again=custom.canonicalRun(array,2);
 t.equal(typeof custom.importObject.env.static_ready_ColdWordDependency,'function','custom dependency retains callable fallback');
 t.equal(again[0],0,'custom dependency can refuse normally');again[2].take(again[1]);
 t.equal(checks,1,'custom dependency guard runs exactly once');
 t.equal(reads,0,'custom refusal still precedes the field read');
 t.end();
});

test('Wasm readiness follows live class state and preserves token identity', t => {
  const j = new JVM({jit:{compileWorker:false}});
  const token = j.getClassInitializationToken('Probe');
  const guard = token.wasmReadinessGuard();
  t.equal(guard(), 0, 'uninitialized class stays cold');
  t.equal(token.wasmReadinessGuard(), guard, 'one Wasm getter per token');
  for (const state of ['INITIALIZING','INITIALIZED','ERRONEOUS','INITIALIZED']) {
    j.classInitializationState.set('Probe', state);
    t.equal(guard(), state === 'INITIALIZED' ? 1 : 0, state + ' is visible to existing guard');
    t.equal(token.initialized, state === 'INITIALIZED', 'JavaScript agrees with Wasm');
  }
  j.classInitializationState.delete('Probe');
  t.equal(guard(), 0, 'deletion invalidates existing guard');
  j._setClassInitializationState('Probe', 'INITIALIZED');
  t.equal(guard(), 1, 'internal state update publishes readiness');
  j.classInitializationState.clear();
  t.equal(guard(), 0, 'clear invalidates existing guard');
  token.initialized = true;
  t.equal(guard(), 1, 'direct token assignment remains supported');
  j._refreshClassInitializationTokens();
  t.equal(guard(), 0, 'state refresh updates existing guard');
  t.equal(j.getClassInitializationToken('Probe'), token, 'token identity survives state transitions');
  const warm = new ClassInitializationToken('INITIALIZED');
  t.equal(warm.wasmReadinessGuard()(), 1, 'lazy Wasm creation captures current readiness');
  warm.initialized = false;
  t.equal(warm.wasmReadinessGuard()(), 0, 'independent token can be reset');
  t.equal(guard(), 0, 'tokens do not share mutable flags');
  t.end();
});

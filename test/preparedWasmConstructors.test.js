'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm');
const compile=require('./javaFixture').makeJavaFixtureCompiler('prepared-wasm-ctor-');

test('AOT honors existing ordinary-constructor compilation policy',async t=>{
 const classpath=compile(t,'PreparedCtorMain',`
class PreparedLoopObject { int value; PreparedLoopObject(int n){for(int i=0;i<n;i++)value+=i*3+1;} }
public class PreparedCtorMain { static int result; public static void main(String[] args){result=new PreparedLoopObject(100).value;} }
`);
 for(const enabled of [false,true]){
  const j=new JVM({classpath,jit:{compileWorker:false,structuredSsa:true,wasmStructured:true,
   preparedCompleteWasm:true,wasm:{compileConstructors:enabled,noOnDemandCalleeCompile:true}}});
  await j.preloadClasspathClasses();j.jit.wasmJit.enabled=true;
  await j.precompileInitializedClasses({initializedOnly:false,effectful:true,wasm:true,wasmPreparedUpgradesOnly:false});
  const method=j.findMethod(j.classes.PreparedLoopObject,'<init>','(I)V'),w=j.jit.wasmJit;
  t.equal(w.state.get(method)?.status==='ready',enabled,'AOT respects constructor policy '+enabled);
  t.notEqual(j.classInitializationState.get('PreparedLoopObject'),'INITIALIZED','AOT does not initialize class');
  j.jit._syncCompileEnvironment={trace:false,assert:true};w.freezeCompilation();
  await j.run('PreparedCtorMain',{prepare:false});
  t.equal(j.classes.PreparedCtorMain.staticFields.get('result:I'),14950,'constructor writes exact object state');
  t.equal(j.jit.syncCompileCensus().postMainSyncCompileCount,0,'prepared construction needs no compiler');
 }
 t.end();
});

test('canonical construction resumes an unfinished object without reallocating',async t=>{
 const {supportsWasmJsTag}=require('../src/jit/wasmShared');
 if(!supportsWasmJsTag()){t.pass('engine retains atomic constructor bridge');t.end();return;}
 const Frame=require('../src/core/frame'),Stack=require('../src/core/callStack');
 const classpath=compile(t,'CanonicalConstruction',`
class NativeConstruction {
 int value;
 NativeConstruction(int[] progress){CanonicalConstruction.created++;CanonicalConstruction.saved=this;value=1;CanonicalConstruction.fill(progress);value+=10;}
}
public class CanonicalConstruction {
 static int created;static NativeConstruction saved;
 static void fill(int[] progress){for(int i=0;i<3;i++)progress[i]++;}
 static int build(int[] progress){try{return new NativeConstruction(progress).value;}catch(ArrayIndexOutOfBoundsException e){return -23;}}
}`);
 const j=new JVM({classpath,wasmHeap:true,jit:{enabled:false,compileWorker:false,
  retainCompilerDiagnostics:false,wasmStructured:true,wasm:{compileConstructors:true,
   deepInline:false,canonicalDirectCalls:true,canonicalEhLinks:true,nativeJsExceptionTags:true}}});
 await j.preloadClasspathClasses();for(const c of ['CanonicalConstruction','NativeConstruction'])j._markClassInitialized(c);
 const w=j.jit.wasmJit;
 const prepare=(owner,name,descriptor)=>{const method=j.findMethod(j.classes[owner],name,descriptor),s=w.methodState({method});
  w.compile({method,className:owner},s,{asCallee:true});t.equal(s.status,'ready',s.lastCompileError||name+' compiles');return s;};
 const fill=prepare('CanonicalConstruction','fill','([I)V');
 const ctor=prepare('NativeConstruction','<init>','([I)V');
 const build=prepare('CanonicalConstruction','build','([I)I');
 t.ok(ctor.meta.canonicalRun,'ordinary constructor exports precise canonical frames');
 w.enabled=true;
 t.ok(j.jit.hasReadyWasmModuleForSynchronousCall(ctor.method),'canonical constructor may own prepared entry');
 w.ctorCompileEnabled=false;
 t.notOk(j.jit.hasReadyWasmModuleForSynchronousCall(ctor.method),'disabled constructor policy retains legacy entry');
 w.ctorCompileEnabled=true;
 t.ok(build.meta.normalFlowFullyCompiled,'allocating caller links a suspending constructor');
 const fields=j.classes.CanonicalConstruction.staticFields;
 const execute=async n=>{
  fields.set('created:I',0);const progress=j.wasmHeap.alloc('[I',n);progress.type='[I';
  const frame=new Frame(build.method);frame.className='CanonicalConstruction';frame.locals[0]=progress;
  const thread={id:0,status:'runnable',callStack:new Stack()};thread.callStack.push(frame);j.threads=[thread];j.currentThreadIndex=0;
  let value=w.execute(frame,thread,build,0).value,steps=0;
  while(!thread.callStack.isEmpty()&&++steps<10000){const current=thread.callStack.peek(),ins=current.instructions[current.pc++].instruction;
   if((typeof ins==='string'?ins:ins?.op)==='ireturn')value=current.stack.peek();if(ins)await j.executeInstruction(ins,current,thread);}
  t.ok(thread.callStack.isEmpty(),'construction continuation finishes');
  t.equal(fields.get('created:I'),1,'constructor begins once');
  t.equal(ctor.meta.directFrameContext.frames.size,0,'constructor releases transferred frame');
  return {value,progress,saved:fields.get('saved:LNativeConstruction;')};
 };
 fill.meta.canonicalFuel.value=1;const resumed=await execute(3);
 t.equal(resumed.value,11,'fuel exit preserves constructor receiver state');
 t.deepEqual([...resumed.progress],[1,1,1],'callee effects are not replayed');
 const {readField}=require('../src/core/objectModel');
 t.equal(readField(resumed.saved.fields,'NativeConstruction.value'),11,'escaped reference remains the initialized receiver');
 fill.meta.canonicalFuel.value=100000000;const thrown=await execute(2);
 t.equal(thrown.value,-23,'constructor throwable reaches allocating caller handler');
 t.deepEqual([...thrown.progress],[1,1],'failed constructor keeps only preceding effects');
 t.equal(readField(thrown.saved.fields,'NativeConstruction.value'),1,'failed constructor retains unfinished object state');
 t.end();
});

test('prepared cold allocations preserve initialization order and native constructor exits',async t=>{
 const classpath=compile(t,'ColdAllocation',`
class ColdAllocated {
 static int initialized=initialize(); int value;
 static int initialize(){ColdAllocation.initializations++;ColdAllocation.observed=ColdAllocation.effects;return 7;}
 ColdAllocated(){ColdAllocation.constructions++;value=initialized;}
}
public class ColdAllocation {
 static int effects,initializations,observed,constructions,result;
 static int build(boolean take,boolean fail){
  effects++;if(!take)return 5;effects+=10;
  ColdAllocated value=new ColdAllocated();effects+=100;
  if(fail)throw new RuntimeException();return value.value;
 }
 static int caught(boolean take,boolean fail){try{return build(take,fail);}catch(RuntimeException e){return -17;}}
 static void entry(boolean take,boolean fail){result=caught(take,fail);}
}`);
 for(const structured of [false,true]){
  const j=new JVM({classpath,wasmHeap:true,wasmFields:true,jit:{enabled:false,compileWorker:false,
   retainCompilerDiagnostics:false,wasmStructured:structured,wasm:{compileConstructors:true,deepInline:false,
    canonicalDirectCalls:true,canonicalEhLinks:true,nativeJsExceptionTags:true,nativeInstanceExits:true}}});
  await j.preloadClasspathClasses();j._markClassInitialized('ColdAllocation');
  for(const field of ['effects','initializations','observed','constructions','result'])j.classes.ColdAllocation.staticFields.set(field+':I',0);
  const w=j.jit.wasmJit;w.enabled=true;
  for(const [owner,name,desc] of [['ColdAllocated','<init>','()V'],['ColdAllocation','build','(ZZ)I']]){
   const method=j.findMethod(j.classes[owner],name,desc),state=w.methodState({method});
   w.compile({method,className:owner},state,{asCallee:true});
   t.equal(state.status,'ready',state.lastCompileError||name+' prepares');
  }
  const build=j.findMethod(j.classes.ColdAllocation,'build','(ZZ)I'),state=w.state.get(build);
  t.ok(state.meta.deoptableCalls>0,'prepared allocation retains a cold initialization guard');
  if(structured && require('../src/jit/wasmShared').supportsWasmTryTable())t.ok(state.meta.structured && state.meta.normalFlowFullyCompiled,'structured body covers the cold native constructor site');
  t.notEqual(j.classInitializationState.get('ColdAllocated'),'INITIALIZED','preparation does not run initializer');
  const fields=j.classes.ColdAllocation.staticFields;
  const run=async(take,fail)=>{
   const Frame=require('../src/core/frame'),Stack=require('../src/core/stack');
   const method=j.findMethod(j.classes.ColdAllocation,'entry','(ZZ)V');
   const frame=new Frame(method);frame.className='ColdAllocation';frame.locals[0]=take;frame.locals[1]=fail;
   const thread={id:0,status:'runnable',callStack:new Stack(),pendingException:null};
   thread.callStack.push(frame);j.threads=[thread];j.currentThreadIndex=0;
   let ticks=0;
   while(thread.callStack.size()){
    const current=thread.callStack.peek();
    if(current.method===build && current.pc===0){const prepared=w.prepare(current);if(prepared)w.execute(current,thread,prepared.st,prepared.blk);}
    if(!thread.callStack.size())break;
    await j.executeTick();if(++ticks>10000)throw Error('tick limit');
   }
   return fields.get('result:I');
  };
  w.freezeCompilation();j.jit._syncCompileEnvironment={trace:false,assert:true};j.jit.markMainStarted();
  t.equal(await run(0,0),5,'untaken allocation returns normally');
  t.equal(fields.get('initializations:I'),0,'untaken branch leaves class cold');
  t.equal(await run(1,0),7,'first allocation returns initialized state');
  t.equal(fields.get('observed:I'),12,'initializer observes preceding effects exactly once');
  t.equal(fields.get('effects:I'),112,'cold continuation does not replay effects');
  t.equal(await run(1,0),7,'prepared warm allocation keeps exact result');
  t.equal(fields.get('initializations:I'),1,'initializer executes once');
  t.equal(fields.get('constructions:I'),2,'each object is constructed once');
  t.equal(await run(1,1),-17,'rare native exception constructor reaches original handler');
  t.equal(fields.get('effects:I'),334,'exception continuation preserves exactly-once effects');
  t.equal(fields.get('constructions:I'),3,'throwing invocation does not repeat allocation');
  t.equal(j.jit.syncCompileCensus().postMainSyncCompileCount,0,'cold and warm execution never compiles');
 }
 t.end();
});


test('guard-only prepared selection follows emitted coverage rather than inline policy',t=>{
 const j=new JVM({jit:{compileWorker:false,wasm:{deepInline:false,canonicalDirectCalls:true,canonicalEhLinks:true,compileConstructors:true}}});
 const h=j.jit,w=h.wasmJit;w.enabled=true;
 const method={name:'<init>',descriptor:'()V',flags:[]};
 const state=w.methodState({method});state.status='ready';
 state.meta={structured:true,canonicalRun(){},guardOnlyNormalFlowGaps:true,
  externalEntry:new Set([0]),blockOfItem:new Map([[0,0]]),boxedCount:0};
 h.hasBackwardBranch=()=>true;
 t.notOk(h.hasPreparedDeepInlineWasmUpgrade(method),'unprepared method remains excluded');
 h.preparedCodegenMethods.add(method);
 t.ok(h.hasPreparedDeepInlineWasmUpgrade(method),'emitted guarded body can own entry with deep inlining disabled');
 state.meta.boxedCount=1;t.notOk(h.hasPreparedDeepInlineWasmUpgrade(method),'boxed state retains fallback');state.meta.boxedCount=0;
 state.meta.guardOnlyNormalFlowGaps=false;t.notOk(h.hasPreparedDeepInlineWasmUpgrade(method),'unsupported islands cannot claim guarded coverage');state.meta.guardOnlyNormalFlowGaps=true;
 state.meta.canonicalRun=null;t.notOk(h.hasPreparedDeepInlineWasmUpgrade(method),'legacy constructor retains atomic entry');state.meta.canonicalRun=()=>{};
 state.runs=64;state.exits=32;t.notOk(h.hasPreparedDeepInlineWasmUpgrade(method),'unproductive guarded body retains exit-storm fallback');
 t.end();
});

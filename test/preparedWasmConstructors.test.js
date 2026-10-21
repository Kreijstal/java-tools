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

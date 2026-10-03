'use strict';
const test=require('tape');
const {isNoOpExceptionHandler,liveExceptionRanges}=require('../src/jit/wasmShared');
const op=instruction=>({instruction});
test('only an unchanged rethrow may bypass Wasm exception dispatch',t=>{
 const plain=[op({op:'astore',arg:'3'}),op({op:'aload',arg:'3'}),op('athrow')];
 t.ok(isNoOpExceptionHandler(plain,0,new Map()),'same throwable rethrow is transparent');
 t.ok(isNoOpExceptionHandler([op('athrow')],0,new Map()),'direct rethrow is transparent');
 for(const instructions of [
  [op('astore_1'),op('aload_2'),op('athrow')],
  [op('astore_1'),op('aload_1'),op({op:'invokestatic',arg:['Method','Reporter',['wrap','(Ljava/lang/Throwable;)Ljava/lang/RuntimeException;']]}),op('athrow')],
  [op('astore_1'),op({op:'new',arg:'java/lang/IllegalArgumentException'}),op('dup'),op({op:'invokespecial',arg:['Method','java/lang/IllegalArgumentException',['<init>','()V']]}),op('athrow')],
 ]) {
  t.notOk(isNoOpExceptionHandler(instructions,0,new Map()),'replacement or reporting call requires exception dispatch');
  const code={codeItems:[op('aconst_null'),op('athrow'),...instructions],exceptionTable:[{startLbl:'L0',endLbl:'L2',handlerLbl:'L2',catch_type:'any'}]};
  t.deepEqual(liveExceptionRanges({},code,new Map([['L0',0],['L2',2]])),[[0,2]],'protected range stays live');
 }
 t.end();
});

test('compiled reporter handler preserves replacement exception and side effects',async t=>{
 const {JVM}=require('../src/core/jvm');
 const Frame=require('../src/core/frame'),CallStack=require('../src/core/callStack');
 const {supportsWasmTryTable}=require('../src/jit/wasmShared');
 const compile=require('./javaFixture').makeJavaFixtureCompiler('wasm-reporter-effects-');
 const classpath=compile(t,'ReporterEffects',`
public class ReporterEffects {
 static int reports;
 static int read(int[] values) {
  try { return values[0]; }
  catch(RuntimeException e) { reports++; throw new IllegalArgumentException("wrapped", e); }
 }
}`);
 const j=new JVM({classpath,jit:{compileWorker:false,wasmStructured:true}});
 await j.preloadClasspathClasses();
 // This fixture starts after class initialization; seed the JVM's default static value.
 j.classes.ReporterEffects.staticFields.set('reports:I',0);
 j._setClassInitializationState('ReporterEffects','INITIALIZED');
 const method=await j.findMethodInHierarchy('ReporterEffects','read','([I)I'),w=j.jit.wasmJit,state=w.methodState({method});
 w.compile({method,className:'ReporterEffects'},state,{asCallee:true});
 if(!supportsWasmTryTable()) {t.notEqual(state.status,'ready','unsupported engine retains canonical execution');t.end();return;}
 t.equal(state.status,'ready',state.lastCompileError||'protected method compiles');
 t.ok(state.meta.usedEh,'reporter is covered by native exception dispatch');
 const frame=new Frame(method);frame.className='ReporterEffects';frame.locals[0]=null;
 const thread={id:1,status:'runnable',callStack:new CallStack()};thread.callStack.push(frame);
 j.threads=[thread];j.currentThreadIndex=0;
 const result=w.execute(frame,thread,state,0);
 t.notOk(result.returned,'throw enters the original handler rather than returning');
 let thrown,steps=0;
 try {
  while(!thread.callStack.isEmpty()&&++steps<200){
   const f=thread.callStack.peek(),ins=f.instructions[f.pc++].instruction;
   if(ins)await j.executeInstruction(ins,f,thread);
  }
 }catch(error){thrown=error;}
 t.ok(steps<200,'handler completes within the fixture bound');
 t.equal(thrown?.type,'java/lang/IllegalArgumentException','replacement exception is preserved');
 t.equal(j.classes.ReporterEffects.staticFields.get('reports:I'),1,'reporter side effect executes exactly once');
 t.end();
});

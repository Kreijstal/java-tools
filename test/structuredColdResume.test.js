'use strict';
// Tests a JS or partial-Wasm tier: the closed-world module would take its methods.
process.env.JVM_CLOSED_WORLD = '0';
const test=require('tape');
const {JVM}=require('../src/core/jvm');
const Frame=require('../src/core/frame'),Stack=require('../src/core/stack');
const {getOp}=require('../src/jit/wasmShared');
const fixture=require('./javaFixture').makeJavaFixtureCompiler('structured-cold-resume-');

for(const heap of [false,true])for(const invalidate of [false,true])for(const mode of ['direct','monitor','throw'])for(const refuse of [false,true])
test(`cold initialization hands back to the proved native loop (heap=${heap}, invalidate=${invalidate}, mode=${mode}, refuse=${refuse})`,async t=>{
 const classpath=fixture(t,'ColdCheckpoint',`public class ColdCheckpoint {
  static int prefixes,steps,tails,initializerPrefix,result;
  static Object lock;static boolean fail=${mode==='throw'};
  static int kernel(int n){prefixes++;int sum=ColdSeed.seed;
   for(int i=0;i<n;i++){steps++;sum=sum*33+ReadyStep.step(i);}tails++;return sum;}
  static int monitored(int n){try{synchronized(lock){return kernel(n);}}catch(ArithmeticException e){return 77;}}
  public static void main(String[] args){int ready=ReadyStep.ready;lock=new int[1];result=${mode==='direct'?'kernel':'monitored'}(20);}
 }
 class ColdSeed {static int seed;static{ColdCheckpoint.initializerPrefix=ColdCheckpoint.prefixes;seed=17;}}
 class ReadyStep {static int ready,calls;static{ready=1;}
  static int step(int i){calls++;if(ColdCheckpoint.fail&&i==3)return 1/(i-3);return i&7;}}
 `);
 const j=new JVM({classpath,wasmHeap:heap,wasmFields:heap,wasmHeapMb:1,prepareBeforeMain:false,
  jit:{codegen:true,compileWorker:false,retainCompilerDiagnostics:false,scalarLoops:true,
   structuredSsa:true,rendererPipeline:true,compiledCallChains:true,effectfulMonitorCodegen:true,
   scalarGuestBodies:true,preparedCompleteWasm:true,preparedLoopLeafWasm:true,
   wasm:{structured:true,canonicalDirectCalls:true,canonicalEhLinks:true,nativeJsExceptionTags:true}}});
 await j.preloadClasspathClasses();const w=j.jit.wasmJit;w.enabled=true;
 await j.precompileInitializedClasses({initializedOnly:false,effectful:true,wasm:true,wasmPreparedUpgradesOnly:false});
 const monitored=j.findMethod(j.classes.ColdCheckpoint,'monitored','(I)I');
 w.compile({method:monitored,className:'ColdCheckpoint'},w.methodState({method:monitored}),{asCallee:true});
 const method=j.findMethod(j.classes.ColdCheckpoint,'kernel','(I)I'),state=w.state.get(method);
 t.equal(state?.status,'ready','native kernel is prepared while its dependency is cold');
 t.ok(state.meta.structuredResumeEntry,'native loop has a state-reconstruction proof');
 t.notEqual(j.classInitializationState.get('ColdSeed'),'INITIALIZED','preparation does not run the initializer');
 const entries=[],execute=w.execute.bind(w);
 const checkpoints=[],checkpoint=w.structuredResumeCheckpoint.bind(w);
 w.structuredResumeCheckpoint=(frame,...args)=>{const pc=checkpoint(frame,...args);if(frame.method===method)checkpoints.push({pc,tokens:state.meta.initializationGuardTokens.map(t=>t.initialized)});return pc;};
 let entered=0;const enter=j.jit.monitorEnter.bind(j.jit);
 j.jit.monitorEnter=(...args)=>{const result=enter(...args);if(result)entered++;return result;};
 let invalidated=false;
 let refusals=0;const native=state.run;
 state.run=(...args)=>{
  if(refuse&&state.meta.box.frame?.pc===state.meta.structuredResumeEntry.item){
   refusals++;return state.meta.structuredResumeEntry.item;
  }
  return native(...args);
 };
 w.execute=(frame,thread,s,...args)=>{
  if(s===state){
   entries.push({pc:frame.pc,osr:!!args[2]});
   if(invalidate&&!invalidated&&frame.pc===state.meta.structuredResumeEntry.item){
    invalidated=true;j.classInitializationState.delete('ReadyStep');
   }
   if(entries.length>50)throw Error('checkpoint retry did not make progress');
  }
  return execute(frame,thread,s,...args);
 };
 j.jit._syncCompileEnvironment={trace:false,assert:true};w.freezeCompilation();
 const fields=j.classes.ColdCheckpoint.staticFields;
 if(mode==='direct')await j.run('ColdCheckpoint',{prepare:false});
 else{
  j._markClassInitialized('ColdCheckpoint');
  for(const name of ['prefixes','steps','tails','initializerPrefix','result'])fields.set(name+':I',0);
  fields.set('fail:Z',mode==='throw'?1:0);fields.set('lock:Ljava/lang/Object;',Object.assign([0],{type:'[I'}));
  const parent=j.findMethod(j.classes.ColdCheckpoint,'monitored','(I)I');
  const main=j.findMethod(j.classes.ColdCheckpoint,'main','([Ljava/lang/String;)V');
  const carrier=new Frame(main),frame=new Frame(parent);frame.className='ColdCheckpoint';frame.locals[0]=20;
  carrier.className='ColdCheckpoint';
  carrier.pc=carrier.instructions.findIndex(item=>getOp(item.instruction)==='invokestatic'&&item.instruction.arg[2][0]==='monitored')+1;
  t.ok(carrier.pc>0,'prepared caller resumes after its monitored invoke');
  const thread={id:0,status:'runnable',callStack:new Stack(),pendingException:null};
  thread.callStack.push(carrier);j.threads=[thread];j.currentThreadIndex=0;
  await j.initializeClassIfNeeded('ReadyStep',thread);
  while(thread.callStack.size()>1)await j.executeTick();
  j.jit.markMainStarted();thread.callStack.push(frame);
  const immediate=w.runNested(frame,thread);
  t.ok(immediate.exited,'native synchronized parent materializes its cold child');
  await j.execute();
 }
 let expected=17;for(let i=0;i<20;i++)expected=(Math.imul(expected,33)+(i&7))|0;
 if(mode==='throw')expected=77;
 t.equal(fields.get('result:I'),expected,'loop result is exact');
 t.equal(fields.get('prefixes:I'),1,'caller prefix runs once');
 t.equal(fields.get('initializerPrefix:I'),1,'initializer observes the preceding caller effect');
 t.equal(fields.get('steps:I'),mode==='throw'?4:20,'each loop effect runs once up to an exception');
 t.equal(fields.get('tails:I'),mode==='throw'?0:1,'caller tail runs only on normal return');
 t.equal(j.classes.ReadyStep.staticFields.get('calls:I'),mode==='throw'?4:20,'child calls execute exactly once');
 t.equal(entered,mode==='direct'?0:1,'caller monitor is entered once');
 t.notOk(fields.get('lock:Ljava/lang/Object;').isLocked,'caller monitor is released on return or exception');
 t.equal(fields.get('lock:Ljava/lang/Object;').lockCount||0,0,'caller retains no monitor ownership');
 t.ok(entries.some(x=>x.pc===state.meta.structuredResumeEntry.item&&!x.osr),
  'completed initialization resumes the structured primary at the proved header');
 t.ok(checkpoints.some(x=>x.pc>=0)&&checkpoints.filter(x=>x.pc>=0).every(x=>x.tokens.every(Boolean)),
  'checkpoint eligibility requires every guarded owner to be initialized');
 if(invalidate)t.ok(invalidated,'a native readiness guard is invalidated after the handoff request');
 if(refuse)t.equal(refusals,1,'an unsupported native checkpoint is attempted only once per invocation');
 t.equal(j.jit.syncCompileCensus().postMainSyncCompileCount,0,'initialization and re-entry compile no Java');
 t.end();
});

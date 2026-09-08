'use strict';
const test=require('tape'),fs=require('fs'),os=require('os'),path=require('path');
const frontend=require('../src/java-frontend');
const {JVM}=require('../src/core/jvm');
const Frame=require('../src/core/frame'),Stack=require('../src/core/stack');

test('void completion guard preserves restoring-call outcomes',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'void-completion-'));
 t.teardown(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'Completion.java');
 fs.writeFileSync(file,`public class Completion {
  static void leaf(int[] a){a[0]++;}
  static void caller(int[] a,int n){for(int i=0;i<n;i++){if((i&1)==0)leaf(a);else leaf(a);a[1]++;}}
 }`);
 frontend.compileJavaFile(file,{outputDir:dir});
 const observed=[];
 for(const caughtEnabled of [false,true])for(const rawEnabled of [false,true])for(const captureFree of [false,true])for(const enabled of [false,true]){
  const j=new JVM({classpath:dir,jit:{compileWorker:false,structuredSsa:true,
   profileMethods:false,structuredContinuations:false,structuredCompactRestoringVoidCalls:enabled,
   structuredLoopInlineRestoringSpills:captureFree,rawRestoringCalls:rawEnabled,caughtRuntimeCalls:caughtEnabled}});
  await j.preloadClasspathClasses();j._setClassInitializationState('Completion','INITIALIZED');
  const method=j.findMethod(j.classes.Completion,'caller','([II)V');
  const g=j.jit.getGeneratedFunction(method,{allowEffectfulCalls:true,compileLocally:true});
  t.ok(g?.jvmRestoringDirectPositionalBody,'restoring body exists, enabled='+enabled);
  if(!g?.jvmRestoringDirectPositionalBody)continue;
  t.equal(g.jvmRestoringDirectPositionalSource.includes('coldRestoringVoidCall'),enabled&&captureFree,'cold helper emitted only for supported enabled entry');
  t.notOk(g.jvmRestoringDirectPositionalSource.includes('__JVM_DEOPT_CALL_'),'fallback markers are fully expanded');
  if(caughtEnabled)t.notOk(g.jvmRestoringDirectPositionalSource.includes('try {'),'catching is outside the generated caller');
  const rebound=j.jit.materializeGeneratedResult(j.jit.serializeGeneratedResult(g),method);
  t.ok(rebound?.jvmRestoringDirectPositionalBody,'restoring body transports');
  for(const selected of [g,rebound]){
  const site={op:'invokestatic',params:['int[]','int'],returnType:'void',descriptor:'([II)V',initializationToken:{initialized:true}};
  const target={method,lookupClass:'Completion',generated:selected,freeFrame:null};
  const invoke=j.jit.getPositionalGeneratedInvoker(site,target);
  const rows=[];
  for(const mode of ['normal','otherValue','async','deopt','child','childAsync','childDeopt','blocked','throw']){
   const a=new Int32Array(2),thread={status:'runnable',callStack:new Stack()};
   const child=new Frame(method);child.className='Completion';
   const failure={deopt:true,transient:true,reason:'test refusal'};
   const thrown=new Error('test exception');let calls=0,rawCalls=0;
   const callee=(array,_thread)=>{
    calls++;array[0]++;
    if(mode.startsWith('child'))thread.callStack.push(child);
    if(mode==='async'||mode==='childAsync')return j.jit.asyncInvokeSentinel();
    if(mode==='deopt'||mode==='childDeopt')return failure;
    if(mode==='blocked')thread.status='blocked';
    if(mode==='throw')throw thrown;
    if(mode==='otherValue')return 0;
    return j.jit.returnVoid();
   };
   callee.jvmDebugGuarded=true;callee.jvmRestoresExceptionFrames=true;
   const rawPlan={};callee.jvmRawRestoringPlan=rawPlan;
   callee.jvmRawRestoringBody=(helpers,plan,array,currentThread)=>{
    if(helpers!==j.jit||plan!==rawPlan)throw Error('raw binding mismatch');
    rawCalls++;return callee(array,currentThread);
   };
   for(const s of j.jit.syncCallSites.filter(s=>s?.callerMethod===method))s.fastPositional={invoke:callee,rawInvoke:null,receiverType:null};
   // The canonical fallback must expose the same result without a second
   // synthetic guest effect; it represents a refused fast entry.
   j.jit.tryInvokeSyncAtSite=()=>j.jit.asyncInvokeSentinel();
   let out,exception;try{out=invoke(a,2,thread);}catch(e){exception=e;}
   t.equal(rawCalls,rawEnabled&&!caughtEnabled?calls:0,'selected route uses the exact helper/plan binding');
   rows.push({mode,calls,pixels:[...a],reason:out?.reason||null,status:thread.status,
    exception:exception===thrown,frames:thread.callStack.items.map(f=>({pc:f.pc,stack:f.stack.items.map(x=>x===a?'array':x),child:f===child}))});
   if(mode==='normal'||mode==='otherValue')t.deepEqual([...a],[2,2],'both branch-local completion sites advance exactly once');
   else t.equal(a[1],0,'caller does not advance on '+mode);
   if(mode==='throw')t.equal(exception,thrown,'exception identity preserved');
  }
  observed.push(rows);
  }
 }
 t.equal(observed.length,32,'caught/raw/bound routes, spill layouts, arms and transported bodies exercised');
 for(const rows of observed.slice(1))t.deepEqual(rows,observed[0],'all normal, suspension and exception states match control');
 t.end();
});

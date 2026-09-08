'use strict';
// Explicit integration fixture: CHECKED_SPAN_JAR must name the frozen reduction.
const test=require('tape');
const {JVM}=require('../src/core/jvm');
const Stack=require('../src/core/stack');
const {verifySpan,compactBody,prepare}=require('../src/jit/CheckedSpanExperiment');
test('frozen span checked representation and original recovery',async t=>{
 if(!process.env.CHECKED_SPAN_JAR){t.skip('set CHECKED_SPAN_JAR to run the frozen reduction integration');t.end();return;}
 const j=new JVM({classpath:process.env.CHECKED_SPAN_JAR,jit:{compileWorker:false,
   structuredSsa:true,preferWholeMethodJs:true,prepareColdIntegerInlines:true,
   compiledCallChains:true,profileMethods:false}});
 await j.preloadClasspathClasses();
 const m=j.findMethod(j.classes.LogoFlatSpan,'draw','(I[IIII)V');
 const g=j.jit.getGeneratedFunction(m,{allowEffectfulCalls:true,compileLocally:true});
 const proof=verifySpan(j.jit,m,g);
 const kernel=new Function('tag,array,start,color,count','let completed=false;'+compactBody(proof)+';return completed;');
 for(const owner of ['LogoFlatSpan','LogoRasterState'])j._setClassInitializationState(owner,'INITIALIZED');
 j.classes.LogoRasterState.staticFields.set('opaque:I',0);
 const invoke=j.jit.getPositionalGeneratedInvoker({op:'invokestatic',params:['int','int[]','int','int','int'],
   returnType:'void',descriptor:m.descriptor,initializationToken:{initialized:true}},
   {method:m,lookupClass:'LogoFlatSpan',generated:g,freeFrame:null});
 t.ok(invoke,'canonical prepared invoker');
 for(const [tag,start,count,length,suspend] of [
   [-103,0,2,4,false],[-103,0,254,256,false],[-103,0,255,256,false],
   [-103,0,0,-1,false],[-103,0,2,-1,false],[-103,1,4,4,false],
   [0,0,2,4,false],[-103,0,-1,4,false],[-103,0,600,600,true],
   [-103,0,-2147483648,600,true]]){
  const results=[];
  for(const useCompact of [false,true]){
   const a=length<0?null:new Int32Array(length).fill(100);
   const thread={status:'runnable',callStack:new Stack()};
   let polls=0; j.jit.continueStructuredQuantum=()=>{polls++;return !suspend;};
   let result,error;const admitted=useCompact&&kernel(tag,a,start,7,count);
   try {result=admitted?j.jit.returnVoid:invoke(tag,a,start,7,count,thread);}catch(e){error=e;}
   const normalize=v=>v===a&&a!==null?'array':typeof v==='symbol'?String(v):v;
   results.push({admitted,pixels:a&&[...a],polls,error:error?.type||error?.message||null,
    result:admitted?'Symbol(jit.return.void)':typeof result==='symbol'?String(result):result&&{deopt:result.deopt,reason:result.reason},
    frames:thread.callStack.items.map(f=>({method:f.method.name,pc:f.pc,locals:f.locals.map(normalize),stack:f.stack.items.map(normalize)}))});
  }
  const [base,compact]=results;
  if(tag===-103&&length>=start+count&&count>=0&&count<=254&&length>=0)t.ok(compact.admitted,'real compact admission');
  else t.notOk(compact.admitted,'recovery case uses canonical body');
  delete base.admitted;delete compact.admitted;
  t.deepEqual(compact,base,'same pixels, exception, poll and suspended state '+[tag,start,count,length,suspend]);
  if(count===2&&length===4)t.deepEqual(base.pixels,[57,57,100,100],'writes actually occurred, even before divide failure');
  if(suspend)t.ok(base.polls>0,'long path really polls');
  if(suspend)t.ok(base.frames.length>0,'suspension really retains recoverable frames');
  if(tag===0||count>0&&(length<0||start+count>length)&&!suspend)t.ok(base.error||base.frames.length>0,'exception path really throws or restores handler');
 }
 t.end();
});

test('both compact placements retain selected caller recovery and transport',async t=>{
 if(!process.env.CHECKED_SPAN_JAR){t.skip('set CHECKED_SPAN_JAR');t.end();return;}
 const all=[];
 for(const placement of ['control','callee','inline']){
  const spec={caller:['LogoFlatTriangle','draw','(IIII[IIIII)V'],
   callee:['LogoFlatSpan','draw','(I[IIII)V'],placement:placement==='control'?'callee':placement,countEntries:true};
  const j=new JVM({classpath:process.env.CHECKED_SPAN_JAR,jit:{compileWorker:false,
   structuredSsa:true,preferWholeMethodJs:true,prepareColdIntegerInlines:true,
   compiledCallChains:true,profileMethods:false,checkedSpanExperiment:spec,
   checkedLeafDirectPositional:false,ordinaryAdaptiveFramelessPositional:true,scalarGuestBodies:true,scalarLoops:true}});
  await j.preloadClasspathClasses();
  await j.precompileInitializedClasses({initializedOnly:false,effectful:true,wasm:false});
  const parent=j.findMethod(j.classes.LogoFlatTriangle,'draw',spec.caller[2]);
  const child=j.findMethod(j.classes.LogoFlatSpan,'draw',spec.callee[2]);
  const g=j.jit.getGeneratedFunction(parent,{allowEffectfulCalls:true,compileLocally:true});
  if(placement!=='control')t.equal(prepare(j.jit,spec).pc,365,'same selected site');
  for(const owner of ['LogoFlatTriangle','LogoFlatSpan','LogoRasterState'])j._setClassInitializationState(owner,'INITIALIZED');
  const fields=j.classes.LogoRasterState.staticFields;
  fields.set('opaque:I',0);fields.set('width:I',32);fields.set('height:I',16);fields.set('stride:I',32);
  fields.set('rows:[I',Int32Array.from({length:16},(_,i)=>i*32));
  const rebound=j.jit.materializeGeneratedResult(j.jit.serializeGeneratedResult(g),parent);
  t.ok(rebound?.jvmRestoringDirectPositionalBody,'caller transports');
  for(const site of j.jit.syncCallSites.filter(s=>s?.callerMethod===parent&&s.methodName==='draw'&&s.declaredClassName==='LogoFlatSpan')){
   const target={method:child,lookupClass:'LogoFlatSpan',generated:j.jit.codegenCache.get(child),freeFrame:null};
   const invoke=j.jit.getPositionalGeneratedInvoker(site,target);
   site.fastStaticTarget=target;site.fastPositional={invoke,rawInvoke:null,lookupClass:'LogoFlatSpan',receiverType:null,debugGuarded:true};
  }
  const observations=[];
  const cases=['normal','normal','null','bounds','identity','debug','blocked','unready-helper','unready-field'];
  for(const body of [g,rebound])for(const kind of cases){
   const a=kind==='null'?null:new Int32Array(kind==='bounds'?2:512).fill(100);
   const thread={status:'runnable',callStack:new Stack()};
   if(kind==='blocked')thread.status='blocked';
   const invoke=j.jit.getPositionalGeneratedInvoker({op:'invokestatic',params:['int','int','int','int','int[]','int','int','int','int'],
    returnType:'void',descriptor:parent.descriptor,initializationToken:{initialized:true}},
    {method:parent,lookupClass:'LogoFlatTriangle',generated:body,freeFrame:null});
   const state=j.jit.checkedSpanState,expected=state?.expectedBody;
   if(state&&kind==='identity')state.expectedBody=null;
   const check=j.jit.needsBytecodeChecks;
   if(kind==='debug')j.jit.needsBytecodeChecks=()=>true;
   const token=kind.startsWith('unready-')?j.getClassInitializationToken('LogoRasterState'):null;
   const initialized=token?.initialized;if(token)token.initialized=false;
   const before=j.jit.checkedSpanEntries||0;let result,error;
   try{result=invoke(5,1,7,110,a,4,16,2,0,thread);}catch(e){error=e;}
   if(state)state.expectedBody=expected;j.jit.needsBytecodeChecks=check;
   if(token)token.initialized=initialized;
   const entries=(j.jit.checkedSpanEntries||0)-before;
   if(placement!=='control'&&kind==='normal'&&observations.length%cases.length===1)t.ok(entries>0,'selected compact path executes in original/transported body');
   if(['identity','debug','blocked','unready-helper','unready-field'].includes(kind))t.equal(entries,0,'guard declines compact path: '+kind);
   const normalize=v=>v===a&&a!==null?'array':typeof v==='symbol'?String(v):v;
   observations.push({pixels:a&&[...a],error:error?.type||error?.message||null,
    result:typeof result==='symbol'?String(result):result&&{deopt:result.deopt,reason:result.reason},
    frames:thread.callStack.items.map(f=>({method:f.method.name,pc:f.pc,locals:f.locals.map(normalize),stack:f.stack.items.map(normalize)}))});
  }
  if(!observations[1].pixels.some(x=>x===57))t.comment(JSON.stringify({...observations[1],pixels:observations[1].pixels.slice(0,10)}));
  t.ok(observations[1].pixels.some(x=>x===57),'real caller rasterized');
  all.push(observations);
 }
 t.deepEqual(all[1],all[0],'callee placement preserves caller recovery');
 t.deepEqual(all[2],all[0],'inline placement preserves caller recovery');
 t.end();
});

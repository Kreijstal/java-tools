"use strict";
const test = require('tape');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const {JVM} = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const StructuredWasmCompiler = require('../src/jit/StructuredWasmCompiler');
const {booleanStaticCaptures, capturesBooleanStatic, supportsWasmTryTable} = require('../src/jit/wasmShared');
const compile = makeJavaFixtureCompiler('opaque-normal-flow-');
const source = `public class BoolKernel {
 public static boolean enabled;
 public static void flip() { enabled = !enabled; }
 public static int call(int[] a, int n) { return loop(a,n); }
 public static int loop(int[] a, int n) {
  boolean saved = enabled;
  try { for (int i=0;i<n;i++) { flip(); a[i] += saved ? 7 : 3; } }
  catch (RuntimeException e) { return saved ? 41 : 43; }
  return saved ? 11 : 13;
 }
}`;
async function harness(t, enabled) {
 const j = new JVM({classpath:[compile(t,'BoolKernel',source)],jit:{enabled:false,
  compileWorker:false,wasmNormalFlowPreparedUpgrades:true,
  wasm:{structured:true,opaqueNormalFlow:enabled}}});
 await j.loadClassByName('BoolKernel');
 j.classInitializationState.set('BoolKernel','INITIALIZED');
 const method=j.findMethod(j.classes.BoolKernel,'loop','([II)I');
 j.jit.wasmJit.enabled=true;
 return {j,method,w:j.jit.wasmJit};
}
test('opaque normal-flow selection preserves the ordinary backedge gate', async t=>{
 const {j,method,w}=await harness(t,true);
 t.ok(capturesBooleanStatic(method),'fixture captures a boolean across an invocation');
 const captures=booleanStaticCaptures(method);
 t.equal(captures.length,1,'one captured local');
 t.equal(captures[0].slot,2,'capture identifies the verifier local');
 t.ok(Object.isFrozen(captures)&&Object.isFrozen(captures[0]),'cached proof inputs immutable');
 t.ok(j.jit.hasControlFlowBackedge(method),'real loop present');
 t.notOk(j.jit.hasBackwardBranch(method),'general opaque-control guard remains closed');
 t.notOk(j.jit.isPreparedNormalFlowWasmCandidate(method),'cold method is not selected');
 j.jit.preparedCodegenMethods.add(method);
 t.ok(j.jit.isPreparedNormalFlowWasmCandidate(method),'prepared primitive loop eligible');
 w.normalFlowPreparedUpgradesEnabled=false;
 t.ok(j.jit.isPreparedNormalFlowWasmCandidate(method),'opaque selection does not enable unrelated normal-flow upgrades');
 j.jit.preparedWasmMethodKeys.add('Other.loop([II)I');
 t.notOk(j.jit.isPreparedNormalFlowWasmCandidate(method),'explicit selection excludes other opaque loops');
 j.jit.preparedWasmMethodKeys.add('BoolKernel.loop([II)I');
 j.jit.preparedWasmMethodMatches.delete(method);
 t.ok(j.jit.isPreparedNormalFlowWasmCandidate(method),'selected opaque loop admitted');
 j.jit.preparedWasmMethodKeys.clear();
 w.opaqueNormalFlowEnabled=false;
 t.notOk(j.jit.isPreparedNormalFlowWasmCandidate(method),'new admission remains opt-in');
 w.opaqueNormalFlowEnabled=true;
 for(const descriptor of ['([II)[I','([II)Ljava/lang/Thread;']){
  const reference={...method,descriptor};j.jit.preparedCodegenMethods.add(reference);
  t.notOk(j.jit.isPreparedNormalFlowWasmCandidate(reference),'reference/array return excluded: '+descriptor);
 }
 t.end();
});
test('captured integer spill proof requires a reaching typed value and an actual spill', t=>{
 const proof=Object.create(StructuredWasmCompiler.prototype);
 proof.booleanStaticCaptures=[{slot:2,storeIndex:3}];
 function check(state,index,spills,expected,message){
  proof.booleanStaticSpillProof=true;proof.booleanStaticSpillSites=0;
  proof.recordBooleanStaticSpill(new Map(state),index,spills);
  t.equal(proof.booleanStaticSpillProof,expected,message);
  t.equal(proof.booleanStaticSpillSites,1,'canonical exit counted');
 }
 check([],0,[],true,'entry before capture has no captured local to retain');
 check([[2,{op:'phi',kind:'I'}]],4,[{slot:2}],true,'captured integer reaches emitted spill');
 check([[2,{op:'phi',kind:'I'}]],4,[],false,'missing emitted spill refuses admission');
 check([],4,[{slot:2}],false,'missing reaching value refuses admission');
 check([[2,{op:'undef',kind:'I'}]],4,[{slot:2}],false,'undefined reaching value refuses admission');
 check([[2,{op:'phi',kind:'R'}]],4,[{slot:2}],false,'conflicting local type refuses admission');
 t.end();
});
test('opaque normal-flow installation requires EH support and excludes dispatcher/raw links',async t=>{
 const {j,method,w}=await harness(t,true);
 const st=w.methodState({method});
 w.compile({className:'BoolKernel',method},st,{entryPath:'regression'});
 if(!supportsWasmTryTable()){
  t.notEqual(st.status,'ready','without native EH support the captured-boolean module is rejected');
  t.equal(st.failReason,'partial module captures a boolean static','original guard remains authoritative');
 }else{
  t.equal(st.status,'ready','complete normal-flow EH module installed');
  t.ok(st.meta.booleanStaticSpillProof,'all canonical exits retain captured integer');
  t.ok(st.meta.booleanStaticSpillSites>0,'real spill sites checked');
  t.ok(st.meta.normalFlowFullyCompiled&&st.meta.usedEh,'normal flow complete with precise EH');
  t.ok(st.meta.frameEntryOnly,'frame ownership explicit');
  t.notOk(st.osr,'partial dispatcher unavailable for resumption');
  t.notOk(st.callee,'no raw callee companion');
  t.equal(w.findReadyStatic('BoolKernel','loop','([II)I'),null,'raw linking rejected');
  t.equal(w.staticLinkClassification('BoolKernel','loop','([II)I'),'incompatible','pending-link classifier agrees');
 }
 t.end();
});

test('prepared positional Wasm frames are reused only after scheduler retirement', async t=>{
 const classpath=compile(t,'WasmFrameReuse',`public class WasmFrameReuse {
  public static int answer;
  public static int loop(int[] a,int n) { int sum=0;for(int i=0;i<n;i++){a[i]+=3;sum+=a[i];}return sum; }
  public static void drive(int[] a,int n) {int sum=0;for(int k=0;k<4;k++)sum+=loop(a,n);answer=sum;}
 }`);
 const j=new JVM({classpath,jit:{compileWorker:false,codegen:true,rendererPipeline:true,
  structuredSsa:true,compiledCallChains:true,preferWholeMethodJs:true,preparedLoopLeafWasm:true,
  preparedWasmPositionalFrames:true,wasm:{structured:true}}});
 await j.loadClassByName('WasmFrameReuse');j.classInitializationState.set('WasmFrameReuse','INITIALIZED');
 const method=j.findMethod(j.classes.WasmFrameReuse,'loop','([II)I');
 const h=j.jit,w=h.wasmJit;w.enabled=true;
 const st=w.methodState({method});w.compile({className:'WasmFrameReuse',method},st,{entryPath:'regression'});
 t.equal(st.status,'ready','real numeric module ready');
 // This engine-independent fixture verifies the adapter/retirement ABI. The
 // native-EH fixture above separately proves captured-boolean admission.
 st.meta.frameEntryOnly=true;st.meta.booleanStaticSpillProof=true;st.osr=null;
 h.preparedCodegenMethods.add(method);
 const target={method,lookupClass:'WasmFrameReuse'};
 const site={op:'invokestatic',params:['int[]','int'],returnType:'int',initializationToken:{initialized:true}};
 const invoke=h.getPreparedWasmPositionalInvoker(site,target);
 t.ok(invoke?.jvmPreparedWasmFrameAdapter,'canonical adapter published');
 const thread={id:0,status:'runnable',callStack:new (new Frame(method)).stack.constructor(),pendingException:null};
 j.threads=[thread];j.currentThreadIndex=0;
 const a=[1,2,3];a.type='[I';
 t.equal(invoke(a,3,thread),15,'first Wasm return forwarded exactly');
 const first=target.freeFrame;
 t.ok(first,'completed frame returned to pool');
 t.equal(invoke(a,3,thread),24,'second invocation executes Wasm again');
 t.equal(target.freeFrame,first,'retired frame reused');
 t.equal(thread.callStack.size(),0,'no active frame retained on ordinary returns');
 site.initializationToken.initialized=false;
 t.equal(typeof invoke(a,3,thread),'symbol','cold static owner requests canonical initialization');
 t.deepEqual(Array.from(a),[7,8,9],'initialization guard runs before guest effects');
 t.equal(thread.callStack.size(),0,'cold-owner refusal leaves stack unchanged');
 site.initializationToken.initialized=true;
 const run=st.run;st.run=(...args)=>{args[args.length-1]=2;return run(...args);};
 const exit=invoke(a,3,thread);st.run=run;
 t.ok(exit.deopt&&exit.transient,'fuel exit returns a scheduler handoff');
 t.equal(target.freeFrame,null,'suspended child never published for reuse');
 t.equal(thread.callStack.peek(),first,'same frame remains scheduler-owned');
 let ticks=0;while(thread.callStack.size()){await j.executeTick();if(++ticks>10000)throw Error('tick limit');}
 t.deepEqual(Array.from(a),[10,11,12],'resumption preserves exactly-once mutations');
 const drive=j.findMethod(j.classes.WasmFrameReuse,'drive','([II)V');
 h.preparedCodegenMethods.add(drive);h.getGeneratedFunction(drive);
 st.run=(...args)=>{args[args.length-1]=2;return run(...args);};
 const root=new Frame(drive);root.className='WasmFrameReuse';root.locals[0]=a;root.locals[1]=3;
 thread.callStack.push(root);ticks=0;
 while(thread.callStack.size()){await j.executeTick();if(++ticks>10000)throw Error('caller tick limit');}
 st.run=run;
 t.equal(j.classes.WasmFrameReuse.staticFields.get('answer:I'),222,'generated caller resumes with exactly one result per suspended call');
 t.deepEqual(Array.from(a),[22,23,24],'generated caller never repeats earlier side effects');
 h.preparedWasmPositionalFrames=false;
 t.equal(h.getPreparedWasmPositionalInvoker(site,target),null,'adapter opt-in preserved');
 t.end();
});

test('canonical scheduler frames cannot bypass the fence through direct loop OSR', async t => {
 const {j,method,w}=await harness(t,true);
 const frame=new Frame(method);frame.className='BoolKernel';
 const thread={status:'runnable'};
 w.canonicalResumeFrames.add(frame);
 const h=j.jit;
 const compileRegions=h.compileInlinePrimitiveLoopRegions;
 let probes=0;h.compileInlinePrimitiveLoopRegions=()=>{probes+=1;};
 t.equal(h.tryRunInlineLoopRegionOsr(frame,thread),false,'direct core OSR call declines a scheduler-owned canonical frame');
 t.equal(probes,0,'no region compilation or execution before canonical resumption');
 t.equal(w.prepare(frame),null,'Wasm resumption also declines');
 w.opaqueNormalFlowEnabled=false;w.canonicalEhLinksEnabled=true;
 t.equal(h.tryRunInlineLoopRegionOsr(frame,thread),false,'canonical bridge mode retains the fence');
 t.equal(probes,0,'bridge mode does not probe regions');
 h.compileInlinePrimitiveLoopRegions=compileRegions;
 t.end();
});

test('frame-only proof excludes compiled resumption after an interpreted prefix', async t => {
 const {method,w}=await harness(t,true);
 const st=w.methodState({method});st.status='ready';st.meta={frameEntryOnly:true};
 const frame=new Frame(method);frame.className='BoolKernel';
 t.notOk(w.requiresCanonicalResume(frame),'fresh invocation can enter its proved module');
 frame.pc=4;
 t.ok(w.requiresCanonicalResume(frame),'mid-loop entry retains materialized captured state');
 t.ok(w.canonicalResumeFrames.has(frame),'ownership persists through handler or caller transitions');
 const ordinary=new Frame({...method});ordinary.pc=4;
 t.notOk(w.requiresCanonicalResume(ordinary),'other methods retain their existing tiers');
 w.opaqueNormalFlowEnabled=false;
 t.notOk(w.requiresCanonicalResume(frame),'default policy remains unchanged');
 t.end();
});

test('only an explicit canonical bridge can link a captured-boolean EH module', async t => {
 const {j,method,w}=await harness(t,true);
 const st=w.methodState({method});st.status='ready';
 st.meta={frameEntryOnly:true,normalFlowFullyCompiled:true,usedEh:true,
  booleanStaticSpillProof:true,boxedCount:0};
 const args=['BoolKernel','loop','([II)I'];
 const ready=()=>w.findReadyStatic(...args,true,false,true,true);
 const classify=()=>w.staticLinkClassification(...args,true,true);
 t.equal(ready(),null,'explicit request still requires runtime option');
 w.canonicalEhLinksEnabled=true;
 t.equal(w.findReadyStatic(...args),null,'raw lookup remains excluded');
 t.equal(w.staticLinkClassification(...args),'incompatible','raw classification remains excluded');
 t.equal(ready(),st,'proved frame-based link admitted');
 t.equal(classify(),'compatible','classification agrees with canonical lookup');
 for(const field of ['normalFlowFullyCompiled','usedEh','booleanStaticSpillProof']) {
  st.meta[field]=false;
  t.equal(ready(),null,'link requires '+field);
  t.equal(classify(),'incompatible','classification requires '+field);
  st.meta[field]=true;
 }
 st.meta.boxedCount=1;
 t.equal(ready(),null,'boxed module remains excluded');
 t.equal(classify(),'incompatible','boxed classification remains excluded');
 t.end();
});

test('explicit canonical callers can select a proved loop-free entry without broadening warmup', async t => {
 const {j,w}=await harness(t,true),h=j.jit;
 const caller=j.findMethod(j.classes.BoolKernel,'call','([II)I');
 h.preparedCodegenMethods.add(caller);
 h.preparedWasmMethodKeys.add('BoolKernel.call([II)I');
 t.notOk(h.hasControlFlowBackedge(caller),'fixture is a loop-free call wrapper');
 t.notOk(h.isPreparedCanonicalWasmCallerCandidate(caller),'bridge mode required');
 w.canonicalEhLinksEnabled=true;
 t.ok(h.isPreparedCanonicalWasmCallerCandidate(caller),'explicit prepared call wrapper admitted');
 const st=w.methodState({method:caller});st.status='ready';
 st.meta={normalFlowFullyCompiled:true,externalEntry:new Set([0])};
 t.ok(h.hasPreparedNormalFlowWasmUpgrade(caller),'proved entry selected');
 st.meta.normalFlowFullyCompiled=false;
 t.notOk(h.hasPreparedNormalFlowWasmUpgrade(caller),'incomplete normal flow excluded');
 st.meta.normalFlowFullyCompiled=true;
 h.preparedWasmMethodKeys.clear();
 t.notOk(h.isPreparedCanonicalWasmCallerCandidate(caller),'an empty selection does not admit every caller');
 t.notOk(h.hasPreparedNormalFlowWasmUpgrade(caller),'ordinary loop-free selection remains closed');
 h.preparedWasmMethodKeys.add('BoolKernel.call([II)I');
 w.normalFlowPreparedUpgradesEnabled=false;
 t.notOk(h.isPreparedCanonicalWasmCallerCandidate(caller),'normal-flow preparation remains opt-in');
 t.end();
});

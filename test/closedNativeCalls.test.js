'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm'),Frame=require('../src/core/frame'),Stack=require('../src/core/callStack');
const {newFields,makeObjectRef,writeField,readField}=require('../src/core/objectModel');
const {T,OP,sleb,assembleModule,getOp,takeWasmReturnValue}=require('../src/jit/wasmShared');
const {getNativeObjectStorageOps,nativeObjectStorageTypes}=require('../src/core/nativeObjectStorage');
const compile=require('./javaFixture').makeJavaFixtureCompiler('closed-native-calls-');
const leafBody='int sum=0;for(int i=0;i<n;i++){s.cursor++;s.bits++;s.buffer+=s.input[i]&255;s.read++;sum+=s.buffer;}return sum;';
const prefix='s.cursor+=4;s.bits+=2;s.read+=3;s.buffer+=5;';

test('closed callees compose ownership, exact exits, initialization and replacement',async t=>{
 if(!getNativeObjectStorageOps()||!require('../src/jit/wasmShared').supportsWasmJsTag()){
  t.pass('requires native GC and JS exception tags');t.end();return;
 }
 const classpath=compile(t,'ClosedKernel',`
 class KernelState {byte[] input;int cursor,bits,read,buffer,extra;}
 public class ClosedKernel {
  static KernelState active;static int[] table;
  static int leaf(int n,KernelState s){${leafBody}}
  static int forward(KernelState s){return leaf(1,s)+1;}
  static int mixed(KernelState s,int n){int sum=0;for(int i=0;i<n;i++){${prefix}sum+=leaf(1,s)+s.input[0];}return sum;}
  static int chain(KernelState s,int n){int sum=0;for(int i=0;i<n;i++){${prefix}sum+=forward(s)+s.input[0];}return sum;}
  static int capturedCall(KernelState s,int n){int sum=0;for(int i=0;i<n;i++){byte[] before=s.input;${prefix}sum+=before[0]+leaf(1,s);}return sum;}
  static int boundary(int[] values,int index){return values[index];}
  static int regions(KernelState s,int n,int[] trigger){int before=s.extra;int x=boundary(trigger,0);int sum=0;
   for(int i=0;i<n;i++){s.extra+=2;${prefix}sum+=leaf(1,s)+s.input[0];}return before+x+sum+boundary(trigger,1)+s.extra;}
  static int regionAllocate(KernelState s,int n){int[] temporary=new int[1];int sum=0;
   for(int i=0;i<n;i++){${prefix}sum+=leaf(1,s)+s.input[0];}return sum;}
  static int reenter(KernelState s,int n,int[] trigger){int sum=0;for(int r=0;r<2;r++){
   for(int i=0;i<n;i++){${prefix}sum+=leaf(1,s)+s.input[0];}sum+=boundary(trigger,r);}return sum;}
  static int externalArray(KernelState s,int n,int[] values){int[] temporary=new int[1];int sum=0;
   for(int i=0;i<n;i++){${prefix}sum+=leaf(1,s)+values[i];}return sum;}
  static int rotatingArray(KernelState s,int n,int[] a,int[] b){int[] values=a;int[] temporary=new int[1];int sum=0;
   for(int i=0;i<n;i++){${prefix}sum+=leaf(1,s)+values[0];values=(i&1)==0?b:a;}return sum;}
  static int castRegion(KernelState s,int n,Object values){int[] temporary=new int[1];int sum=0;
   for(int i=0;i<n;i++){${prefix}sum+=leaf(1,s)+((int[])values)[i];}return sum;}
  static int phiCast(KernelState s,int n,Object a,Object b){int[] temporary=new int[1];Object current=a,next=b;int sum=0;
   for(int i=0;i<n;i++){${prefix}sum+=leaf(1,s)+((int[])current)[0];Object swap=current;current=next;next=swap;}return sum;}
  static int castReenter(KernelState s,int n,Object values,int[] trigger){int sum=0;for(int r=0;r<2;r++){
   for(int i=0;i<n;i++){${prefix}sum+=leaf(1,s)+((int[])values)[0];}sum+=boundary(trigger,r);}return sum;}
  static int caughtCast(KernelState s,int n,Object values){try{return castRegion(s,n,values);}catch(ClassCastException e){return -73;}catch(NullPointerException e){return -72;}}
  static int staticRegion(KernelState s,int n){int[] temporary=new int[1];int sum=0;
   for(int i=0;i<n;i++){${prefix}sum+=leaf(1,s)+table[i];}return sum;}
  static int coldStaticRegion(KernelState s,int n){int[] temporary=new int[1];int sum=0;
   for(int i=0;i<n;i++){${prefix}sum+=leaf(1,s)+RegionTable.table[0];}return sum;}
  static int capturedRegion(KernelState s,int n,int[] trigger){byte[] old=s.input;int x=boundary(trigger,0);int sum=0;
   for(int i=0;i<n;i++){${prefix}sum+=leaf(1,s)+old[0];}return sum+x;}
  static int caught(KernelState s,int n){try{return mixed(s,n);}catch(ArrayIndexOutOfBoundsException e){return -71;}catch(NullPointerException e){return -72;}}
  static int cold(KernelState s){${prefix}return ColdKernel.leaf(1,s);}
 }
 class RegionTable {static int[] table={2};static int observed=ClosedKernel.active.bits;}
 class ColdKernel {
  static int observed=ClosedKernel.active.bits;
  static int leaf(int n,KernelState s){${leafBody}}
 }`);
 const j=new JVM({classpath,wasmHeap:true,wasmFields:true,jit:{enabled:false,compileWorker:false,
  retainCompilerDiagnostics:false,wasmStructured:true,wasm:{deepInline:false,maxInlineCalleeItems:1,noOnDemandCalleeCompile:true,
   canonicalDirectCalls:true,canonicalEhLinks:true,nativeJsExceptionTags:true}}});
 await j.preloadClasspathClasses();for(const owner of ['ClosedKernel','KernelState'])j._markClassInitialized(owner);
 const w=j.jit.wasmJit;w.importStatsEnabled=true;
 const build=(name,descriptor,owner='ClosedKernel')=>{
  const method=j.findMethod(j.classes[owner],name,descriptor),state=w.methodState({method});
  w.compile({method,className:owner},state,{asCallee:true});t.equal(state.status,'ready',state.lastCompileError||name+' compiles');return state;
 };
 const leaf=build('leaf','(ILKernelState;)I'),forward=build('forward','(LKernelState;)I'),
  mixed=build('mixed','(LKernelState;I)I'),chain=build('chain','(LKernelState;I)I'),caught=build('caught','(LKernelState;I)I'),
  capturedCall=build('capturedCall','(LKernelState;I)I');
 t.equal(leaf.meta.closedNativeBody?.version,1,'leaf publishes the stronger entry contract');
 t.equal(typeof leaf.meta.canonicalClosedStorageRun,'function','leaf has a dedicated closed export');
 for(const state of [forward,mixed,chain]){
  t.equal(state.meta.nativeClosedCallSiteCount,1,state.key+' reserves a restricted native edge');
  t.equal(state.meta.closedNativeBody?.version,1,'the composed body remains a closed callee');
 }
 t.ok(forward.meta.nativeClosedForwarder,'ordinary forwarder is distinguished from a closed entry root');
 t.notOk(forward.meta.nativeClosedCallRoot,'forwarder metadata alone does not claim ordinary execution reaches the new entry');
 t.ok(mixed.meta.nativeClosedCallRoot,'mixed body can enter the closed graph from its ordinary entry');
 const object=(values=[3],vm=j)=>{
  const input=vm.wasmHeap.alloc('[B',values.length);input.type='[B';input.set(values);
  const value=makeObjectRef(vm,'KernelState',newFields(vm,'KernelState'));writeField(value.fields,'KernelState.input',input);return value;
 };
 const snapshot=value=>Object.fromEntries(['cursor','bits','read','buffer'].map(key=>[key,readField(value.fields,'KernelState.'+key)]));
 const raw=(state,args,fuel=1e8)=>{
  const frame=new Frame(state.method);frame.className='ClosedKernel';state.meta.paramSlots.forEach((p,i)=>frame.locals[p.slot]=args[i]);
  state.meta.box.frame=frame;try{const status=state.run(...args,0,fuel);return {frame,status,value:status===-1?takeWasmReturnValue(state.meta):undefined};}
  finally{state.meta.box.frame=null;}
 };
 const start=(state,args)=>{
  const frame=new Frame(state.method);frame.className='ClosedKernel';state.meta.paramSlots.forEach((p,i)=>frame.locals[p.slot]=args[i]);
  const thread={id:0,status:'runnable',callStack:new Stack()};thread.callStack.push(frame);j.threads=[thread];j.currentThreadIndex=0;
  return {frame,thread,out:w.execute(frame,thread,state,0)};
 };
 const finish=async({thread,out})=>{
  if(thread.callStack.isEmpty())return out.value;
  let result,steps=0;
  while(!thread.callStack.isEmpty()&&++steps<50000){const frame=thread.callStack.peek(),ins=frame.instructions[frame.pc++].instruction;
   if(/^[ilfda]return$/.test(getOp(ins)))result=frame.stack.peek();
   if(ins)try{await j.executeInstruction(ins,frame,thread);}catch(error){j.handleException(error,frame.pc-1,thread);}
  }
  t.ok(thread.callStack.isEmpty(),'exact Java continuation completes');return result;
 };
 t.equal(raw(forward,[object()]).value,4,'ordinary forwarding entry preserves its existing path');
 const before=leaf.meta.importStats.get('closed_native_body_entered')||0,first=object();
 t.equal(raw(mixed,[first,2]).value,30,'mixed native caller observes every child field write');
 t.deepEqual(snapshot(first),{cursor:10,bits:6,read:8,buffer:16},'caller and child effects occur once');
 t.equal((leaf.meta.importStats.get('closed_native_body_entered')||0)-before,2,'actual calls enter the closed leaf export');
 t.equal(mixed.meta.importStats.get('native_body_object_storage'),1,'caller validates ownership once across the native loop');
 const chained=object();t.equal(raw(chain,[chained,2]).value,32,'closed ownership composes through a forwarding body');
 t.equal(forward.meta.importStats.get('closed_native_body_entered'),2,'the middle frame uses its stronger entry');
 t.equal(forward.meta.importStats.get('native_body_object_storage')||0,0,'closed forwarding adds no shape-validation crossing');
 const short=object([]);t.equal(await finish(start(caught,[short,1])),-71,'native child bounds failure reaches the original outer handler');
 t.deepEqual(snapshot(short),{cursor:5,bits:3,read:3,buffer:5},'fault retains parent prefix and the exact child prefix');
 t.equal(await finish(start(caught,[null,1])),-72,'null ownership refusal reaches the original Java handler');
 build('boundary','([II)I');
 const regions=build('regions','(LKernelState;I[I)I'),allocated=build('regionAllocate','(LKernelState;I)I'),
  reenter=build('reenter','(LKernelState;I[I)I'),capturedRegion=build('capturedRegion','(LKernelState;I[I)I');
 for(const state of [regions,allocated,reenter,capturedRegion]){
  t.equal(state.meta.nativeClosedCallSiteCount,1,'mixed method has one actual closed call site');
  t.ok(state.meta.nativeObjectRegionBlockCount>0,'mixed method uses bounded native blocks');
  t.notOk(state.meta.closedNativeBody,'partial regions never publish a whole-method contract');
  t.notOk(state.meta.canonicalClosedStorageRun,'partial method has no trusted whole-method export');
 }
 const partial=object();
 t.equal(raw(regions,[partial,2,[1,2]]).value,37,'native stores invalidate generic field readers after leaving a region');
 t.equal(regions.meta.importStats.get('native_body_object_storage'),1,'a native loop retains ownership across its internal edges');
 t.equal(readField(partial.fields,'KernelState.extra'),4,'region stores execute once');
 const allocState=object();t.equal(raw(allocated,[allocState,2]).value,30,'allocation outside the region preserves the native reader loop');
 const reopened=object(),trigger=[1,2];let callbacksAtBoundary=0;
 Object.defineProperty(trigger,0,{get(){callbacksAtBoundary++;writeField(reopened.fields,'KernelState.input',object([7]).fields['KernelState.input']);return 1;}});
 t.equal(raw(reenter,[reopened,2,trigger]).value,115,'outside callback cannot lend stale ownership to a reentered region');
 t.equal(callbacksAtBoundary,1,'outside operation is neither hoisted nor replayed');
 t.equal(reenter.meta.importStats.get('native_body_object_storage'),2,'reentry revalidates once after the unsupported operation');
 const replaced=object(),replaceTrigger=[1,2];
 Object.defineProperty(replaceTrigger,0,{get(){replaced.fields=Object.fromEntries(Object.entries({input:object([7]).fields['KernelState.input'],...snapshot(replaced)}).map(([name,value])=>['KernelState.'+name,value]));return 1;}});
 const replacedRun=start(reenter,[replaced,2,replaceTrigger]);
 t.equal(getOp(replacedRun.frame.instructions[replacedRun.frame.pc].instruction),'getfield','noncanonical replacement refuses at the original reentry field');
 t.deepEqual(snapshot(replaced),{cursor:10,bits:6,read:8,buffer:16},'reentry refusal precedes the second native prefix');
 t.equal(await finish(replacedRun),115,'reentry fallback preserves completed work and observes the new container');
 const capturedState=object(),captureTrigger=[1];let captures=0;
 Object.defineProperty(captureTrigger,0,{get(){captures++;writeField(capturedState.fields,'KernelState.input',object([9]).fields['KernelState.input']);return 1;}});
 t.equal(raw(capturedRegion,[capturedState,2,captureTrigger]).value,49,'region header follows the captured original array value across an outside callback');
 t.equal(captures,1,'captured-reference boundary runs once');
 const externalArray=build('externalArray','(LKernelState;I[I)I'),rotatingArray=build('rotatingArray','(LKernelState;I[I[I)I');
 const ints=values=>{const input=j.wasmHeap.alloc('[I',values.length);input.type='[I';input.set(values);return input;};
 t.equal(raw(externalArray,[object(),2,ints([2,4])]).value,30,'captured primitive parameter arrays stay inside the closed region');
 t.equal(externalArray.meta.importStats.get('native_body_array_header'),1,'immutable external header is queried once across loop iterations');
 t.equal(raw(externalArray,[object(),0,null]).value,0,'unused null external array is never authenticated or dereferenced');
 const foreignArrayState=object(),foreignArrayRun=start(externalArray,[foreignArrayState,2,[2,4]]);
 t.equal(getOp(foreignArrayRun.frame.instructions[foreignArrayRun.frame.pc].instruction),'iaload','foreign array refuses at its actual access');
 t.deepEqual(snapshot(foreignArrayState),{cursor:5,bits:3,read:4,buffer:8},'array refusal preserves both completed native prefixes');
 t.equal(await finish(foreignArrayRun),30,'foreign array continuation does not replay its completed child call');
 t.equal(raw(rotatingArray,[object(),2,ints([2]),ints([7])]).value,33,'loop-carried arrays acquire headers for their current SSA value');
 const castRegion=build('castRegion','(LKernelState;ILjava/lang/Object;)I'),caughtCast=build('caughtCast','(LKernelState;ILjava/lang/Object;)I');
 t.equal(castRegion.meta.nativeObjectRegionCastCount,1,'primitive array cast participates in the native region');
 t.equal(raw(castRegion,[object(),2,ints([2,4])]).value,30,'owned cast retains the exact original array');
 t.equal(castRegion.meta.importStats.get('native_body_array_cast__I'),1,'loop-invariant cast authenticates once');
 t.equal(castRegion.meta.importStats.get('native_body_array_header')||0,0,'cast proof supplies the array header without a second query');
 const customArray=ints([2,4]);let typeGetters=0;
 Object.defineProperty(customArray,'type',{configurable:true,get(){typeGetters++;return '[I';}});
 const customCastRun=start(castRegion,[object(),1,customArray]);
 t.equal(getOp(customCastRun.frame.instructions[customCastRun.frame.pc].instruction),'checkcast','customized array type refuses at the original cast');
 t.equal(typeGetters,0,'cast proof invokes no host type getter');
 t.equal(await finish(customCastRun),10,'customized type retains the original Java cast behavior');
 t.ok(typeGetters>0,'Java fallback executes the observable type getter');
 const badCastState=object();t.equal(await finish(start(caughtCast,[badCastState,2,object().fields['KernelState.input']])),-73,'failed owned cast reaches the original outer class-cast handler');
 t.deepEqual(snapshot(badCastState),{cursor:5,bits:3,read:4,buffer:8},'failed cast retains the completed child prefix');
 const nullCastState=object();t.equal(await finish(start(caughtCast,[nullCastState,2,null])),-72,'null cast succeeds until the original array access fails');
 const phiCast=build('phiCast','(LKernelState;ILjava/lang/Object;Ljava/lang/Object;)I');
 t.equal(raw(phiCast,[object(),6,ints([2]),ints([7])]).value,195,'parallel phi swaps preserve each array and its certificate');
 t.equal(phiCast.meta.importStats.get('native_body_array_cast__I'),2,'two alternating arrays authenticate once each across loop phis');
 t.ok(phiCast.meta.nativeObjectRegionCastCacheCount>phiCast.meta.nativeObjectRegionCastCount,'bounded upstream closure provides transport through joins');
 const castReenter=build('castReenter','(LKernelState;ILjava/lang/Object;[I)I'),reenterArray=ints([2]),castBoundary=[1,2];let boundaryTypeGets=0;
 Object.defineProperty(castBoundary,0,{get(){Object.defineProperty(reenterArray,'type',{configurable:true,get(){boundaryTypeGets++;return '[I';}});return 1;}});
 const castBoundaryState=object(),castBoundaryRun=start(castReenter,[castBoundaryState,2,reenterArray,castBoundary]);
 t.equal(getOp(castBoundaryRun.frame.instructions[castBoundaryRun.frame.pc].instruction),'checkcast','outside customization revokes a transported cast certificate');
 t.equal(boundaryTypeGets,0,'reentry proof does not invoke the new type getter');
 t.deepEqual(snapshot(castBoundaryState),{cursor:15,bits:9,read:12,buffer:24},'cast reentry retains exactly the completed third child call');
 t.equal(await finish(castBoundaryRun),91,'revoked cast continuation neither drops nor replays loop effects');
 const staticRegion=build('staticRegion','(LKernelState;I)I'),staticFields=j.classes.ClosedKernel.staticFields;
 staticFields.set('table:[I',ints([2,4]));
 t.equal(staticRegion.meta.nativeObjectRegionStaticReadCount,1,'native static array read belongs to the same closed region');
 t.equal(raw(staticRegion,[object(),2]).value,30,'native static read preserves the private array header');
 const staticCell=staticFields.cell('table:[I'),staticValue=ints([2,4]);let staticGetters=0;
 Object.defineProperty(staticCell,'value',{configurable:true,get(){staticGetters++;return staticValue;}});
 const staticRefused=object(),staticRun=start(staticRegion,[staticRefused,2]);
 t.equal(getOp(staticRun.frame.instructions[staticRun.frame.pc].instruction),'getstatic','customized static cell refuses at its actual read');
 t.equal(staticGetters,0,'region guard invokes no custom static getter');
 t.deepEqual(snapshot(staticRefused),{cursor:5,bits:3,read:4,buffer:8},'static refusal preserves the completed child call');
 t.equal(await finish(staticRun),30,'static fallback retains the original result');
 t.equal(staticGetters,2,'fallback executes each original static getter exactly once');
 const coldStatic=build('coldStaticRegion','(LKernelState;I)I'),coldStaticState=object();
 j.classes.RegionTable.staticFields.set('table:[I',ints([2]));staticFields.set('active:LKernelState;',coldStaticState);
 const coldStaticRun=start(coldStatic,[coldStaticState,1]);
 t.equal(getOp(coldStaticRun.frame.instructions[coldStaticRun.frame.pc].instruction),'getstatic','cold static dependency refuses at the original field');
 t.deepEqual(snapshot(coldStaticState),{cursor:5,bits:3,read:4,buffer:8},'static initialization is not hoisted before child effects');
 t.equal(await finish(coldStaticRun),10,'cold static continuation completes after initialization');
 t.equal(j.classes.RegionTable.staticFields.get('observed:I'),3,'static initializer observes the completed child prefix');
 const fuel=leaf.meta.canonicalFuel.value,suspendedState=object();leaf.meta.canonicalFuel.value=2;
 const suspended=start(capturedCall,[suspendedState,2]);
 t.ok(suspended.thread.callStack.size()>1,'callee fuel exit donates its exact activation');
 t.equal(suspended.thread.callStack.peek().method,leaf.method,'pending frame belongs to the suspended leaf');
 t.deepEqual(snapshot(suspendedState),{cursor:5,bits:3,read:4,buffer:8},'fuel exit preserves completed parent and child stores');
 writeField(suspendedState.fields,'KernelState.input',object([9]).fields['KernelState.input']);
 t.equal(await finish(suspended),42,'callee suspension preserves the captured parent operand while observing later field changes');
 t.deepEqual(snapshot(suspendedState),{cursor:10,bits:6,read:8,buffer:22},'nested resume never repeats either prefix');
 leaf.meta.canonicalFuel.value=fuel;
 const coldLeaf=build('leaf','(ILKernelState;)I','ColdKernel'),cold=build('cold','(LKernelState;)I'),coldState=object();
 t.equal(cold.meta.nativeClosedCallSiteCount,1,'cold fixture tests a closed call boundary rather than an inline entry guard');
 j.classes.ClosedKernel.staticFields.set('active:LKernelState;',coldState);
 const coldRun=start(cold,[coldState]);
 t.equal(getOp(coldRun.frame.instructions[coldRun.frame.pc].instruction),'invokestatic','cold dependency retries at the original invoke');
 t.deepEqual(snapshot(coldState),{cursor:4,bits:2,read:3,buffer:5},'cold dependency does not replay or skip caller prefix effects');
 t.notEqual(j.classInitializationState.get('ColdKernel'),'INITIALIZED','native entry does not initialize the dependency early');
 t.equal(await finish(coldRun),8,'cold continuation initializes and executes the original call');
 t.equal(j.classes.ColdKernel.staticFields.get('observed:I'),2,'initializer observes completed prefix writes');
 let callbacks=0;
 const unsafe=new WebAssembly.Instance(new WebAssembly.Module(assembleModule({
  importDecls:[{name:'unsafe',params:[T.i32,T.ref],results:[T.i32]}],
  mainParams:[T.i32,T.ref,[0x63,1]],mainResults:[T.i32,T.i32],declared:[],gcTypes:nativeObjectStorageTypes(),
  body:[OP.i32_const,...sleb(-1),OP.local_get,0,OP.local_get,1,OP.call,0,OP.end]})),
  {env:{unsafe:()=>{callbacks++;return 42;}}}).exports.run;
 leaf.meta.closedNativeBody=null;leaf.meta.canonicalCompactStorageRun=unsafe;w.canonicalDirectLinks.publish(leaf);
 const rejected=object(),retry=start(mixed,[rejected,2]);
 t.equal(callbacks,0,'incompatible replacement executes no callback inside the closed caller');
 t.equal(getOp(retry.frame.instructions[retry.frame.pc].instruction),'invokestatic','unrun replacement retries the exact call');
 t.deepEqual(snapshot(rejected),{cursor:4,bits:2,read:3,buffer:5},'replacement refusal retains the caller prefix');
 t.equal(await finish(retry),30,'replacement refusal uses the original Java method exactly once');
 const regionRejected=object(),regionRetry=start(allocated,[regionRejected,2]);
 t.equal(callbacks,0,'partial region also refuses an incompatible target before callbacks');
 t.deepEqual(snapshot(regionRejected),{cursor:4,bits:2,read:3,buffer:5},'partial refusal retains preceding native prefix');
 t.equal(await finish(regionRetry),30,'mixed-method fallback resumes at the original invoke');
 const deeper=object(),deepRetry=start(chain,[deeper,2]);
 t.equal(callbacks,0,'a compatible forwarding body propagates its child refusal without a callback');
 t.ok(deepRetry.thread.callStack.size()>1,'deeper refusal donates the exact middle activation');
 t.equal(await finish(deepRetry),32,'nested continuation neither replays nor drops either call');
 t.equal(raw(forward,[object()]).value,43,'ordinary entry retains the general canonical target');
 t.equal(callbacks,1,'the callback remains available outside the stronger contract');
 const retired=global.gc?new WeakRef(leaf.meta):null,retiredOwner=global.gc?new WeakRef(leaf.meta.directFrameContext):null;
 w.compile({method:leaf.method,className:'ClosedKernel'},leaf,{asCallee:true});
 t.equal(leaf.status,'ready','replacement recompiles with its original contract');
 t.equal(raw(chain,[object(),2]).value,32,'native targets recover without recompiling the parents');
 if(global.gc){for(let i=0;i<10;i++){await new Promise(setImmediate);global.gc();}
  t.ok(retired.deref()===undefined,'live closed callers retain no replaced leaf metadata');
  t.ok(retiredOwner.deref()===undefined,'live closed callers retain no replaced frame owner');}
 w.canonicalDirectLinks.withdraw(leaf.key);const withdrawn=start(mixed,[object(),2]);
 t.equal(callbacks,1,'withdrawn closed target uses a pure refusal, never its ordinary bridge');
 t.equal(await finish(withdrawn),30,'withdrawal preserves the supported Java fallback');
 t.ok([...(w.nativeObjectInputGlobals?.values()||[])].flat().every(input=>input.value.value===null),'argument publications are clear after all transfers');
 const lateVm=new JVM({classpath,wasmHeap:true,wasmFields:true,jit:{enabled:false,compileWorker:false,
  retainCompilerDiagnostics:false,wasmStructured:true,wasm:{deepInline:false,maxInlineCalleeItems:1,
   canonicalDirectCalls:true,canonicalEhLinks:true,nativeJsExceptionTags:true}}});
 await lateVm.preloadClasspathClasses();for(const owner of ['ClosedKernel','KernelState'])lateVm._markClassInitialized(owner);
 const lateWasm=lateVm.jit.wasmJit,lateMethod=lateVm.findMethod(lateVm.classes.ClosedKernel,'mixed','(LKernelState;I)I'),late=lateWasm.methodState({method:lateMethod});
 lateWasm.compile({method:lateMethod,className:'ClosedKernel'},late,{asCallee:true});
 t.equal(late.status,'ready','normal dependency compilation prepares the caller');
 t.equal(late.meta.nativeClosedCallSiteCount,1,'callee prepared during discovery earns its contract without a manual compile order');
 t.ok(late.meta.nativeOperandSnapshotRetried,'caller rebuilds its needed snapshots after the dependency becomes ready');
 t.equal(raw(late,[object([3],lateVm),2]).value,30,'automatic dependency preparation retains the exact result');
 const lateLeaf=lateVm.findMethod(lateVm.classes.ClosedKernel,'leaf','(ILKernelState;)I');
 lateWasm.canonicalDirectLinks.withdraw('ClosedKernel.leaf(ILKernelState;)I');lateWasm.state.delete(lateLeaf);
 const lateCastMethod=lateVm.findMethod(lateVm.classes.ClosedKernel,'castRegion','(LKernelState;ILjava/lang/Object;)I'),lateCast=lateWasm.methodState({method:lateCastMethod});
 lateWasm.compile({method:lateCastMethod,className:'ClosedKernel'},lateCast,{asCallee:true});
 t.equal(lateCast.status,'ready','default dependency discovery prepares a cast-bearing region');
 t.equal(lateCast.meta.nativeObjectRegionCastCount,1,'closed proof admits the primitive cast without a runtime opt-in flag');
 t.ok(lateCast.meta.nativeOperandSnapshotRetried,'newly ready dependency rebuilds formerly demoted cast snapshots once');
 const lateValues=lateVm.wasmHeap.alloc('[I',2);lateValues.type='[I';lateValues.set([2,4]);
 t.equal(raw(lateCast,[object([3],lateVm),2,lateValues]).value,30,'default cast-region retry preserves the exact result');
 const retryVm=new JVM({classpath,wasmHeap:true,wasmFields:true,jit:{enabled:false,compileWorker:false,
  retainCompilerDiagnostics:false,wasmStructured:true,wasm:{deepInline:false,maxInlineCalleeItems:1,
   canonicalDirectCalls:true,canonicalEhLinks:true,nativeJsExceptionTags:true}}});
 await retryVm.preloadClasspathClasses();for(const owner of ['ClosedKernel','KernelState'])retryVm._markClassInitialized(owner);
 const Compiler=require('../src/jit/StructuredWasmCompiler');
 const retryMethod=retryVm.findMethod(retryVm.classes.ClosedKernel,'mixed','(LKernelState;I)I'),retryWasm=retryVm.jit.wasmJit;
 const originalBody=Compiler.prototype.translateBody,failed=new Error('refused fresh translation');let abandonedSlot;
 Compiler.prototype.translateBody=function(inline){
  if(this.nativeSnapshotRetried){
   t.ok(this.preferCompleteCallee,'snapshot retry preserves the requested callee compilation policy');
   abandonedSlot=this.wasmJit.canonicalDirectLinks.allocateClosed('abandoned',[],[],[]);
   this.canonicalSlots=[abandonedSlot];throw failed;
  }
  return originalBody.call(this,inline);
 };
 try{
  const compiler=new Compiler(retryVm,retryMethod,'ClosedKernel',retryWasm,{asCallee:true});
  t.throws(()=>compiler.translateWith(true),error=>error===failed,'failed retry propagates the original error');
 }finally{Compiler.prototype.translateBody=originalBody;}
 t.notEqual(abandonedSlot,undefined,'failure actually exercises the fresh compiler');
 t.notOk(retryWasm.canonicalDirectLinks.bySlot.has(abandonedSlot),'failed fresh translation releases its unpublished table slot');
 t.end();
});

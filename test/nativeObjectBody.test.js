'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm'),Frame=require('../src/core/frame'),Stack=require('../src/core/callStack');
const Compiler=require('../src/jit/StructuredWasmCompiler');
const {newFields,makeObjectRef,writeField,readField}=require('../src/core/objectModel');
const {takeWasmReturnValue,getOp}=require('../src/jit/wasmShared');
const compile=require('./javaFixture').makeJavaFixtureCompiler('native-object-body-');
const body=`while(s.bits<n){s.buffer=s.buffer<<8|s.input[s.cursor]&255;s.bits+=8;s.cursor++;s.read++;}
 int value=s.buffer>>s.bits-n&(1<<n)-1;s.bits-=n;return value;`;
test('one native object body retains state, exceptions, guarded fallback and suspension',async t=>{
 const classpath=compile(t,'NativeObjectLoop',`
 class ReaderState {byte[] input,alternate;int cursor,read,buffer,bits;long big;double weight;volatile int barrier;}
 class VolatileReaderState {byte[] input;int cursor,read,buffer;volatile int bits;}
 public class NativeObjectLoop {
  static int read(int n,ReaderState s){${body}}
  static int prefix(int n,ReaderState s){s.read++;${body}}
  static int store(int n,ReaderState s){for(int i=0;i<n;i++){s.input[i]=(byte)(s.buffer+i);s.bits++;s.cursor++;s.read++;}return s.bits;}
  static int caughtStore(int n,ReaderState s){try{return store(n,s);}catch(ArrayIndexOutOfBoundsException e){return -71;}}
  static int branched(ReaderState s,int n){while(s.bits<n){s.bits++;s.read++;s.cursor++;if((s.bits&1)==0)s.buffer+=s.input[0];else s.buffer+=s.alternate[0];}return s.buffer;}
  static int beforeArray(ReaderState s,int n){for(int i=0;i<n;i++){s.cursor++;s.bits++;s.read++;s.buffer+=s.input[s.cursor-1];}return s.buffer;}
  static long stacked(ReaderState s,int n){long total=9007199254740993L;for(int i=0;i<n;i++){
   s.cursor++;s.bits++;s.buffer++;total+=(s.alternate[s.read++]=s.input[0]);}return total;}
  static int caller(int n,ReaderState s){return read(n,s)+1;}
  static int caught(int n,ReaderState s){try{return read(n,s);}catch(ArrayIndexOutOfBoundsException e){return -71;}catch(NullPointerException e){return -72;}}
  static int volatileRead(int n,VolatileReaderState s){${body}}
  static long wide(ReaderState s,int n){for(int i=0;i<n;i++){s.big+=s.input[i]&255;s.bits++;s.cursor++;s.read++;}return s.big;}
  static double floating(ReaderState s,int n){for(int i=0;i<n;i++){s.weight+=s.input[i];s.bits++;s.cursor++;s.read++;}return s.weight;}
  static int multiple(ReaderState a,ReaderState b,int n){int sum=0;for(int i=0;i<n;i++){
   a.cursor++;a.bits++;a.read++;a.buffer++;if((i&1)==0)sum+=a.input[0];else sum+=b.input[0]+b.bits;}return sum;}
  static int caughtMultiple(ReaderState a,ReaderState b,int n){try{return multiple(a,b,n);}catch(NullPointerException e){return -72;}}
  static long fieldStore(ReaderState a,ReaderState b,int n){long total=9007199254740993L;for(int i=0;i<n;i++){
   a.cursor++;a.bits++;a.read++;a.buffer++;b.big=total+a.bits;total+=b.big+a.input[0];}return total;}
  static int rotating(ReaderState a,ReaderState b,int n){ReaderState s=a;int sum=0;for(int i=0;i<n;i++){
   s.cursor++;s.bits++;s.read++;s.buffer++;sum+=s.input[0];s=(i&1)==0?b:a;}return sum;}
  static int captured(ReaderState a,ReaderState b,int n){ReaderState s=a;int sum=0;for(int i=0;i<n;i++){
   byte[] old=s.input;s=(i&1)==0?b:a;s.cursor++;s.bits++;s.read++;s.buffer++;
   byte[] next=s.input;sum+=old[0]+next[0];}return sum;}
  static int staleInput(ReaderState a,ReaderState b,int[] trigger){int before=b.bits;int x=trigger[0];return before+multiple(a,b,2)+x;}
  static int prefixArray(ReaderState a,ReaderState b,int n){byte[] old=a.input;int sum=0;for(int i=0;i<n;i++){
   b.cursor++;b.bits++;b.read++;b.buffer++;sum+=old[0]+b.input[0];}return sum;}
 }`);
 const makeVm=async()=>{const j=new JVM({classpath,wasmHeap:true,wasmFields:true,jit:{enabled:false,compileWorker:false,
  retainCompilerDiagnostics:false,wasmStructured:true,wasm:{deepInline:false,canonicalDirectCalls:true,
   canonicalEhLinks:true,nativeJsExceptionTags:true}}});await j.preloadClasspathClasses();
  for(const name of ['NativeObjectLoop','ReaderState','VolatileReaderState'])j._markClassInitialized(name);return j;};
 const j=await makeVm(),w=j.jit.wasmJit;w.importStatsEnabled=true;
 const build=(name,descriptor)=>{const method=j.findMethod(j.classes.NativeObjectLoop,name,descriptor),state=w.methodState({method});
  w.compile({method,className:'NativeObjectLoop'},state,{asCallee:true});t.equal(state.status,'ready',state.lastCompileError||name+' compiles');return state;};
 const read=build('read','(ILReaderState;)I'),caller=build('caller','(ILReaderState;)I'),caught=build('caught','(ILReaderState;)I');
 t.ok(read.meta.nativeObjectBodyFieldSites>=4,'stateful array loop selects one native body');
 t.equal(read.meta.nativeObjectBodyArraySites,1,'array access is separately authenticated');
 t.ok(read.meta.deoptableCalls>0,'callers account for guarded entry refusal');t.notOk(read.meta.structuredResumeEntry,'resumed state cannot skip the entry guard');
 const bytes=(vm,xs)=>{const a=vm.wasmHeap.alloc('[B',xs.length);a.type='[B';a.set(xs);return a;};
 const object=(vm,input)=>{const o=makeObjectRef(vm,'ReaderState',newFields(vm,'ReaderState'));
  for(const [key,value]of Object.entries({input,cursor:0,read:0,buffer:0,bits:0,big:9007199254740993n,weight:0.125}))writeField(o.fields,'ReaderState.'+key,value);return o;};
 const snapshot=o=>Object.fromEntries(['cursor','read','buffer','bits'].map(key=>[key,readField(o.fields,'ReaderState.'+key)]));
 const reference=(n,input,state={cursor:0,read:0,buffer:0,bits:0})=>{
  while(state.bits<n){if(state.cursor>=input.length)throw Error('reference bounds');state.buffer=state.buffer<<8|input[state.cursor]&255;state.bits+=8;state.cursor++;state.read++;}
  const value=state.buffer>>(state.bits-n)&((1<<n)-1);state.bits-=n;return {value,state};
 };
 const raw=(state,args,fuel=1e8)=>{const frame=new Frame(state.method);frame.className='NativeObjectLoop';state.meta.box.frame=frame;
  try{const status=state.run(...args,0,fuel);return {status,value:status===-1?takeWasmReturnValue(state.meta):undefined,frame};}
  finally{state.meta.box.frame=null;}};
 const finish=async(frame,thread)=>{
  if(!thread){thread={id:0,status:'runnable',callStack:new Stack()};thread.callStack.push(frame);}
  j.threads=[thread];j.currentThreadIndex=0;let value,steps=0;
  while(!thread.callStack.isEmpty()&&++steps<50000){const current=thread.callStack.peek(),ins=current.instructions[current.pc++].instruction;
   if(/^[ilfda]return$/.test(typeof ins==='string'?ins:ins?.op))value=current.stack.peek();
   if(ins)try{await j.executeInstruction(ins,current,thread);}catch(error){j.handleException(error,current.pc-1,thread);}}
  t.ok(thread.callStack.isEmpty(),'continuation completes');return value;
 };
 const execute=async(state,args)=>{
  const frame=new Frame(state.method);frame.className='NativeObjectLoop';state.meta.paramSlots.forEach((p,i)=>frame.locals[p.slot]=args[i]);
  const thread={id:0,status:'runnable',callStack:new Stack()};thread.callStack.push(frame);j.threads=[thread];j.currentThreadIndex=0;
  state.meta.canonicalFuel.value=1e8;const result=w.execute(frame,thread,state,0);
  return thread.callStack.isEmpty()?result.value:finish(null,thread);
 };
 const data=[-1,3,127,-128,5,6,7,8];
 for(const n of [0,1,3,8,9,16,24,31,32]){
  const o=object(j,bytes(j,data)),expected=reference(n,data),result=raw(read,[n,o]);
  t.equal(result.status,-1,'native read completes for '+n);t.equal(result.value,expected.value,'exact value for '+n);
  t.deepEqual(snapshot(o),expected.state,'exact mutable state for '+n);
 }
 t.equal(read.meta.importStats.get('native_object_body_entered'),9,'actual native entries are counted');
 t.equal(read.meta.importStats.get('native_object_body_array_entered'),8,'zero-bit call skips array ownership; repeated refills reuse it');
 const captures=read.meta.importStats.get('object_storage')||0;
 const native=object(j,bytes(j,data));t.equal(await execute(caller,[16,native]),reference(16,data).value+1,'canonical native caller retains the scalar result');
 t.equal(read.meta.importStats.get('object_storage')||0,captures,'private native calls add no receiver lookup');
 const plain={type:'ReaderState',fields:{}};for(const [key,value]of Object.entries({input:bytes(j,data),cursor:0,read:0,buffer:0,bits:0}))plain.fields['ReaderState.'+key]=value;
 let result=raw(read,[8,plain]);t.equal(result.status,0,'plain fields hand off before Java effects');
 t.deepEqual(snapshot(plain),{cursor:0,read:0,buffer:0,bits:0},'refusal does not mutate plain fields');
 result.frame.pc=result.status;t.equal(await finish(result.frame),255,'plain fallback computes the original value');
 t.equal(await execute(caught,[1,null]),-72,'null receiver reaches the original caller handler');
 const short=object(j,bytes(j,[19]));t.equal(await execute(caught,[9,short]),-71,'native bounds failure reaches the caller handler');
 t.deepEqual(snapshot(short),{cursor:1,read:1,buffer:19,bits:8},'fault preserves every completed state write');
 t.ok(read.meta.directFrameContext.throwCount>0,'native fault is recorded by the corrected census');
 const other=await makeVm();const foreignObject=object(other,bytes(other,data));
 result=raw(read,[16,foreignObject]);t.equal(result.status,0,'foreign object memory refuses native access');result.frame.pc=result.status;
 t.equal(await finish(result.frame),reference(16,data).value,'foreign object fallback remains exact');
 const foreignArray=object(j,bytes(other,data));result=raw(read,[16,foreignArray]);t.ok(result.status>=0,'foreign array memory refuses before its first use');result.frame.pc=result.status;
 t.equal(await finish(result.frame),reference(16,data).value,'foreign array fallback remains exact');
 const prefix=build('prefix','(ILReaderState;)I'),prefixState=object(j,bytes(other,data));
 t.ok(prefix.meta.nativeObjectBodyFieldSites>0,'prefix fixture selects the native object body');
 result=raw(prefix,[8,prefixState]);t.ok(result.status>0,'foreign array spills at the later array-use block');
 t.equal(snapshot(prefixState).read,1,'the earlier prefix executes before refusal');result.frame.pc=result.status;
 t.equal(await finish(result.frame),255,'late fallback computes the exact reader result');
 t.equal(snapshot(prefixState).read,2,'earlier prefix is not replayed by the fallback');
 const beforeArray=build('beforeArray','(LReaderState;I)I'),beforeState=object(j,bytes(other,data));
 t.ok(beforeArray.meta.nativeObjectBodyFieldSites>0,'store-before-array fixture selects the native object body');
 result=raw(beforeArray,[beforeState,1]);t.ok(result.status>=0,'same-block array refusal returns a continuation');
 t.deepEqual(snapshot(beforeState),{cursor:1,read:1,buffer:0,bits:1},'instruction refusal preserves preceding effects in the same block');
 t.equal(getOp(result.frame.instructions[result.status].instruction),'baload','continuation is the exact load, not the block entry');
 result.frame.pc=result.status;t.equal(await finish(result.frame),-1,'same-block fallback returns the exact signed byte');
 t.deepEqual(snapshot(beforeState),{cursor:1,read:1,buffer:-1,bits:1},'same-block writes execute exactly once');
 const stacked=build('stacked','(LReaderState;I)J'),stackedState=object(j,bytes(other,[7]));
 const destination=bytes(j,[-3]);writeField(stackedState.fields,'ReaderState.alternate',destination);
 t.equal(stacked.meta.instructionExitSiteCount,2,'each load/store has a precise refusal site');
 result=raw(stacked,[stackedState,1]);
 t.equal(getOp(result.frame.instructions[result.status].instruction),'baload','foreign load refuses at its instruction');
 t.deepEqual(snapshot(stackedState),{cursor:1,read:1,buffer:1,bits:1},'field writes and index increment precede the refused load');
 t.equal(destination[0],-3,'pending destination store has not executed');
 result.frame.pc=result.status;
 t.equal(await finish(result.frame),9007199254741000n,'wide arithmetic and reference/index prefix survive the load refusal');
 t.equal(destination[0],7,'pending store runs once after the resumed load');
 t.deepEqual(snapshot(stackedState),{cursor:1,read:1,buffer:1,bits:1},'load continuation does not replay preceding writes');
 const input=bytes(j,[7]),storePrefixState=object(j,input),foreignDestination=bytes(other,[-3]);
 writeField(storePrefixState.fields,'ReaderState.alternate',foreignDestination);
 result=raw(stacked,[storePrefixState,1]);
 t.equal(getOp(result.frame.instructions[result.status].instruction),'bastore','foreign destination refuses at the store');
 input[0]=99;result.frame.pc=result.status;
 t.equal(await finish(result.frame),9007199254741000n,'store continuation uses the already-loaded value and wide prefix');
 t.equal(foreignDestination[0],7,'changing the source after refusal cannot replay the earlier load');
 t.deepEqual(snapshot(storePrefixState),{cursor:1,read:1,buffer:1,bits:1},'store continuation preserves the original increment count');
 const branched=build('branched','(LReaderState;I)I'),branchState=object(j,null);
 t.equal(branched.meta.nativeObjectBodyArraySites,2,'branch fixture selects independently guarded array fields');
 writeField(branchState.fields,'ReaderState.alternate',bytes(j,[3]));
 result=raw(branched,[branchState,1]);t.equal(result.status,-1,'untaken branch does not require its null array');
 t.equal(result.value,3,'selected branch returns the native array value');
 const laterBranch=object(j,bytes(other,[5]));writeField(laterBranch.fields,'ReaderState.alternate',bytes(j,[3]));
 result=raw(branched,[laterBranch,2]);t.ok(result.status>0,'later iteration refuses only the foreign array branch');
 t.deepEqual(snapshot(laterBranch),{cursor:2,read:2,buffer:3,bits:2},'late branch refusal preserves earlier iterations and the current prefix');
 result.frame.pc=result.status;t.equal(await finish(result.frame),8,'branch fallback uses the foreign array correctly');
 t.deepEqual(snapshot(laterBranch),{cursor:2,read:2,buffer:8,bits:2},'branch continuation neither replays nor skips state writes');
 const guardedCaller=object(j,bytes(other,data));
 t.equal(await execute(caught,[8,guardedCaller]),255,'canonical caller consumes a late ownership refusal');
 t.deepEqual(snapshot(guardedCaller),reference(8,data).state,'canonical fallback preserves all mutable state');
 const store=build('store','(ILReaderState;)I'),caughtStore=build('caughtStore','(ILReaderState;)I');
 t.ok(store.meta.nativeObjectBodyFieldSites>0,'array-store fixture selects the native object body');
 const storeState=object(j,bytes(j,[-9]));writeField(storeState.fields,'ReaderState.buffer',5);
 t.equal(await execute(caughtStore,[2,storeState]),-71,'native array-store bounds failure reaches its Java handler');
 t.equal(readField(storeState.fields,'ReaderState.input')[0],5,'array store before failure remains visible');
 t.deepEqual(snapshot(storeState),{cursor:1,read:1,buffer:5,bits:1},'native array-store failure keeps exactly the completed state writes');
 const foreignStore=object(j,bytes(other,[-9,-9]));writeField(foreignStore.fields,'ReaderState.buffer',5);
 t.equal(await execute(caughtStore,[2,foreignStore]),2,'foreign array-store fallback computes the original result');
 t.deepEqual([...readField(foreignStore.fields,'ReaderState.input')],[5,6],'fallback writes every array element exactly');
 t.deepEqual(snapshot(foreignStore),{cursor:2,read:2,buffer:5,bits:2},'array-store continuation updates each field exactly once');
 const nullable=object(j,null);result=raw(read,[0,nullable]);t.equal(result.status,-1,'unused null array completes natively without throwing');
 t.equal(result.value,0,'zero-bit native path never dereferences the null array');
 let getterCalls=0,storedBits=8;Object.defineProperty(plain.fields,'ReaderState.bits',{configurable:true,get(){getterCalls++;return storedBits;},set(value){storedBits=value;}});
 result=raw(read,[0,plain]);t.equal(getterCalls,0,'guard invokes no custom field getter');result.frame.pc=result.status;
 t.equal(await finish(result.frame),0,'custom field fallback preserves the result');t.equal(getterCalls,3,'original field reads remain observable');
 const customized=object(j,bytes(j,data)),customFields=customized.fields;let fieldGets=0;
 Object.defineProperty(customized,'fields',{configurable:true,get(){fieldGets++;return customFields;}});
 result=raw(read,[8,customized]);t.equal(result.status,0,'custom wrapper storage refuses the native body');
 t.equal(fieldGets,0,'entry guard does not invoke the wrapper getter');result.frame.pc=result.status;
 t.equal(await finish(result.frame),255,'custom wrapper fallback retains the Java result');t.ok(fieldGets>0,'fallback executes the original wrapper getter');
 const suspended=object(j,bytes(j,data));result=raw(read,[24,suspended],2);t.ok(result.status>=0,'fuel exits after a completed refill');
 t.deepEqual(snapshot(suspended),{cursor:1,read:1,buffer:255,bits:8},'native suspension has exact partial state');
 const changedInput=bytes(j,[9,10,11,12]),saved=snapshot(suspended);
 suspended.fields=Object.fromEntries(Object.entries({input:changedInput,...saved}).map(([key,value])=>['ReaderState.'+key,value]));
 result.frame.pc=result.status;const expected=reference(24,changedInput,{...saved});
 t.equal(await finish(result.frame),expected.value,'resumed invocation uses the changed field container');t.deepEqual(snapshot(suspended),expected.state,'suspension never reuses stale slab storage');
 t.equal(raw(read,[0,suspended]).status,0,'a fresh entry also rejects replaced field storage');
 const vol=build('volatileRead','(ILVolatileReaderState;)I');t.equal(vol.meta.nativeObjectBodyFieldSites,0,'volatile fields retain ordinary lowering');
 t.equal(vol.meta.nativeOperandSnapshotCount,0,'rejected volatile loop keeps no speculative operand snapshots');
 t.equal(read.meta.nativeOperandSnapshotCount,1,'accepted object loop retains its selected operand snapshot');
 const wide=build('wide','(LReaderState;I)J'),wideObject=object(j,bytes(j,data));
 t.ok(wide.meta.nativeObjectBodyFieldSites>0,'wide state loop selects the native body');
 t.equal(raw(wide,[wideObject,3]).value,9007199254740993n+385n,'wide field updates retain all bits');
 const floating=build('floating','(LReaderState;I)D'),floatObject=object(j,bytes(j,data));
 t.ok(floating.meta.nativeObjectBodyFieldSites>0,'double state loop selects the native body');
 t.equal(raw(floating,[floatObject,3]).value,129.125,'floating field updates preserve original arithmetic');
 const multiple=build('multiple','(LReaderState;LReaderState;I)I'),caughtMultiple=build('caughtMultiple','(LReaderState;LReaderState;I)I');
 t.ok(multiple.meta.nativeObjectBodyLazyReceivers,'multiple receivers use first-use ownership guards');
 t.equal(multiple.meta.nativeObjectBodyReceiverCount,2,'both receiver identities are covered');
 const first=object(j,bytes(j,[3])),second=object(j,bytes(j,[7]));
 t.equal(raw(multiple,[first,second,2]).value,10,'native multi-receiver loop computes both arrays exactly');
 t.deepEqual(snapshot(first),{cursor:2,read:2,buffer:2,bits:2},'multi-receiver prefix writes stay visible');
 const aliased=object(j,bytes(j,[3]));
 t.equal(raw(multiple,[aliased,aliased,2]).value,8,'distinct receiver parameters may alias the same native storage');
 t.deepEqual(snapshot(aliased),{cursor:2,read:2,buffer:2,bits:2},'aliased field reads observe earlier writes through either parameter');
 t.equal(raw(multiple,[object(j,bytes(j,[3])),null,1]).value,3,'untaken null receiver is never authenticated or dereferenced');
 const prefixObject=object(j,bytes(j,[3])),foreignSecond=object(other,bytes(other,[7]));
 result=raw(multiple,[prefixObject,foreignSecond,2]);
 t.equal(getOp(result.frame.instructions[result.status].instruction),'getfield','foreign second receiver refuses at its first field');
 t.deepEqual(snapshot(prefixObject),{cursor:2,read:2,buffer:2,bits:2},'earlier iterations and current field writes precede refusal');
 result.frame.pc=result.status;t.equal(await finish(result.frame),10,'second-receiver continuation retains arithmetic and operands');
 t.deepEqual(snapshot(prefixObject),{cursor:2,read:2,buffer:2,bits:2},'second-receiver fallback never repeats the prefix');
 const nullPrefix=object(j,bytes(j,[3]));
 t.equal(await execute(caughtMultiple,[nullPrefix,null,2]),-72,'first-use receiver refusal reaches the original caller handler');
 t.equal(snapshot(nullPrefix).bits,2,'null fault occurs after the original prefix');
 const fieldStore=build('fieldStore','(LReaderState;LReaderState;I)J'),storeLeft=object(j,bytes(j,[3])),storeRight=object(other,bytes(other,[7]));
 result=raw(fieldStore,[storeLeft,storeRight,1]);
 t.equal(getOp(result.frame.instructions[result.status].instruction),'putfield','foreign wide field store refuses at the store instruction');
 writeField(storeLeft.fields,'ReaderState.bits',99);result.frame.pc=result.status;
 t.equal(await finish(result.frame),18014398509481990n,'wide store continuation retains its already-computed value');
 t.equal(readField(storeRight.fields,'ReaderState.big'),9007199254740994n,'wide value is not recomputed from changed inputs');
 t.equal(readField(storeLeft.fields,'ReaderState.bits'),99,'field-store continuation does not repeat earlier increments');
 const rotating=build('rotating','(LReaderState;LReaderState;I)I'),rotateLeft=object(j,bytes(j,[3])),rotateRight=object(j,bytes(j,[7]));
 t.ok(rotating.meta.nativeObjectBodyLazyReceivers,'loop-carried receivers select first-use guards');
 t.equal(raw(rotating,[rotateLeft,rotateRight,4]).value,20,'receiver phi changes invalidate object and array ownership facts');
 t.deepEqual(snapshot(rotateLeft),{cursor:2,read:2,buffer:2,bits:2},'first receiver keeps its own slab');
 t.deepEqual(snapshot(rotateRight),{cursor:2,read:2,buffer:2,bits:2},'second receiver keeps its own slab');
 const captured=build('captured','(LReaderState;LReaderState;I)I'),captureLeft=object(j,bytes(j,[3])),captureRight=object(j,bytes(j,[7]));
 t.equal(raw(captured,[captureLeft,captureRight,3]).value,30,'captured array headers follow the original value across receiver changes');
 const oldForeign=object(j,bytes(other,[3])),nextNative=object(j,bytes(j,[7]));
 result=raw(captured,[oldForeign,nextNative,1]);
 t.equal(getOp(result.frame.instructions[result.status].instruction),'baload','captured foreign array refuses at its own load');
 t.deepEqual(snapshot(nextNative),{cursor:1,read:1,buffer:1,bits:1},'new receiver effects occur before the captured old-array refusal');
 result.frame.pc=result.status;t.equal(await finish(result.frame),10,'both captured array values survive the precise handoff');
 const staleInput=build('staleInput','(LReaderState;LReaderState;[I)I'),staleLeft=object(j,bytes(j,[3])),staleRight=object(j,bytes(j,[7]));
 let triggerReads=0;const trigger=[0];Object.defineProperty(trigger,0,{get(){triggerReads++;
  staleRight.fields={'ReaderState.input':bytes(j,[11]),'ReaderState.bits':100};return 5;}});
 t.equal(await execute(staleInput,[staleLeft,staleRight,trigger]),119,'first-use proof rejects stale private metadata supplied by a callback-bearing caller');
 t.equal(triggerReads,1,'caller callback is not replayed after the callee refuses');
 t.equal(snapshot(staleLeft).bits,2,'stale-input fallback preserves the native callee prefix');
 const lookupBefore=multiple.meta.importStats.get('native_body_object_storage')||0;
 t.equal(raw(multiple,[null,null,0]).value,0,'zero-trip native loop accepts unused null receivers');
 t.equal(multiple.meta.importStats.get('native_body_object_storage')||0,lookupBefore,'zero-trip loop performs no receiver query');
 const accessorLeft=object(j,bytes(j,[3])),accessorRight=object(j,bytes(j,[7])),savedFields=accessorRight.fields;let firstUseFieldGets=0;
 Object.defineProperty(accessorRight,'fields',{get(){firstUseFieldGets++;return savedFields;}});
 result=raw(multiple,[accessorLeft,accessorRight,2]);
 t.equal(firstUseFieldGets,0,'first-use guard invokes no custom wrapper getter');
 result.frame.pc=result.status;t.equal(await finish(result.frame),10,'custom field wrapper retains its checked continuation');
 t.ok(firstUseFieldGets>0,'original field getter runs only after the handoff');
 const shadowLeft=object(j,bytes(j,[3])),shadowRight=object(j,bytes(j,[7]));let shadowGets=0;
 Object.defineProperty(shadowRight.fields,'ReaderState.bits',{get(){shadowGets++;return 100;}});
 result=raw(multiple,[shadowLeft,shadowRight,2]);
 t.ok(result.status>=0,'own field accessor revokes the closed native-body proof');
 t.equal(shadowGets,0,'ownership validation invokes no shadowing accessor');
 if(result.status>=0){result.frame.pc=result.status;t.equal(await finish(result.frame),110,'shadowing field getter retains the checked Java result');}
 t.ok(rotating.meta.structuredResumeEntry,'lazy receiver ownership has an exact native loop-resume entry');
 const resumeWasEnabled=w.enabled;w.enabled=true;
 const resumeLeft=object(j,bytes(j,[3])),resumeRight=object(j,bytes(j,[7]));
 result=raw(rotating,[resumeLeft,resumeRight,4],2);result.frame.pc=result.status;
 t.equal(result.status,rotating.meta.structuredResumeEntry.item,'fuel exits at the proved header');
 t.ok(w.hasStructuredResumePoint(result.frame),'fuel spill is eligible for native reconstruction');
 const resumeNative=frame=>{
  const thread={id:0,status:'runnable',callStack:new Stack()};thread.callStack.push(frame);j.threads=[thread];j.currentThreadIndex=0;
  return {thread,out:w.execute(frame,thread,rotating,rotating.meta.structuredResumeEntry.block)};
 };
 const resumed=resumeNative(result.frame);
 t.equal(resumed.out.value,20,'native re-entry restores the current receiver phi and accumulator');
 t.ok(resumed.thread.callStack.isEmpty(),'native resumed invocation completes');
 t.deepEqual(snapshot(resumeLeft),{cursor:2,read:2,buffer:2,bits:2},'native resume does not replay earlier receiver writes');
 t.deepEqual(snapshot(resumeRight),{cursor:2,read:2,buffer:2,bits:2},'native resume authenticates the other receiver independently');
 const changedLeft=object(j,bytes(j,[3])),changedRight=object(j,bytes(j,[7]));
 result=raw(rotating,[changedLeft,changedRight,4],2);result.frame.pc=result.status;
 changedRight.fields={'ReaderState.input':bytes(j,[11]),'ReaderState.cursor':0,'ReaderState.bits':0,'ReaderState.read':0,'ReaderState.buffer':0};
 const changedResume=resumeNative(result.frame);
 t.notOk(changedResume.out.returned,'replaced field storage refuses before native field access after resume');
 t.equal(await finish(null,changedResume.thread),28,'native resume observes the changed field container through its fallback');
 t.deepEqual(snapshot(changedLeft),{cursor:2,read:2,buffer:2,bits:2},'field replacement does not replay earlier iterations');
 t.deepEqual(snapshot(changedRight),{cursor:2,read:2,buffer:2,bits:2},'replacement container receives exactly the remaining writes');
 const prefixArray=build('prefixArray','(LReaderState;LReaderState;I)I'),prefixLeft=object(j,bytes(j,[3])),prefixRight=object(j,bytes(j,[7]));
 t.ok(prefixArray.meta.structuredResumeEntry,'array captured before the loop supports native resume');
 result=raw(prefixArray,[prefixLeft,prefixRight,4],2);result.frame.pc=result.status;
 writeField(prefixLeft.fields,'ReaderState.input',bytes(j,[100]));
 const prefixThread={id:0,status:'runnable',callStack:new Stack()};prefixThread.callStack.push(result.frame);j.threads=[prefixThread];j.currentThreadIndex=0;
 const prefixResume=w.execute(result.frame,prefixThread,prefixArray,prefixArray.meta.structuredResumeEntry.block);
 t.equal(prefixResume.value,40,'resume reconstructs the original captured array, not its changed field');
 t.deepEqual(snapshot(prefixRight),{cursor:4,read:4,buffer:4,bits:4},'captured-array resume keeps every write exactly once');
 t.ok(prefixThread.callStack.isEmpty(),'captured-array native resume completes');
 t.ok([...(w.nativeObjectInputGlobals?.values()||[])].flat().every(input=>input.value.value===null),
  'native argument globals remain clear after first-use refusal and resume');
 w.enabled=resumeWasEnabled;
 const scheduled=async(left,right,mutate)=>{
  const frame=new Frame(rotating.method),carrier=new Frame(rotating.method);frame.className='NativeObjectLoop';
  [left,right,4].forEach((value,i)=>frame.locals[rotating.meta.paramSlots[i].slot]=value);
  const thread={id:0,status:'runnable',callStack:new Stack()};thread.callStack.push(carrier);thread.callStack.push(frame);
  j.threads=[thread];j.currentThreadIndex=0;
  const nativeRun=rotating.run,nativeExecute=w.execute.bind(w),jitEnabled=j.jit.enabled,wasmEnabled=w.enabled,entries=[];
  rotating.run=(...args)=>{args[args.length-1]=2;return nativeRun(...args);};
  w.execute=(f,th,state,...args)=>{if(state===rotating)entries.push(f.pc);return nativeExecute(f,th,state,...args);};
  j.jit.enabled=true;w.enabled=true;
  try{let ticks=0;while(thread.callStack.size()>1){
   await j.executeTick();if(++ticks>1000)throw Error('first-use resume failed to make progress');
   if(ticks===1&&mutate)mutate();
  }}finally{rotating.run=nativeRun;w.execute=nativeExecute;j.jit.enabled=jitEnabled;w.enabled=wasmEnabled;}
  t.ok(entries.length>1,'scheduler enters native code after a fuel yield');
  t.equal(entries[1],rotating.meta.structuredResumeEntry.item,'scheduler uses the proved structured checkpoint');
  t.equal(rotating.meta.box.frame,null,'scheduled invocation releases its frame');return carrier.stack.pop();
 };
 const scheduledLeft=object(j,bytes(j,[3])),scheduledRight=object(j,bytes(j,[7]));
 t.equal(await scheduled(scheduledLeft,scheduledRight),20,'actual scheduler preserves changing receivers through repeated native yields');
 t.deepEqual(snapshot(scheduledLeft),{cursor:2,read:2,buffer:2,bits:2},'scheduler does not replay native prefix writes');
 const scheduledChangedLeft=object(j,bytes(j,[3])),scheduledChangedRight=object(j,bytes(j,[7]));
 t.equal(await scheduled(scheduledChangedLeft,scheduledChangedRight,()=>{
  scheduledChangedRight.fields={'ReaderState.input':bytes(j,[11]),'ReaderState.cursor':0,'ReaderState.bits':0,'ReaderState.read':0,'ReaderState.buffer':0};
 }),28,'scheduler makes progress through ownership refusal after a field replacement');
 t.deepEqual(snapshot(scheduledChangedRight),{cursor:2,read:2,buffer:2,bits:2},'scheduled fallback retains exact remaining effects');
 const compiler=new Compiler(j,read.method,'NativeObjectLoop',w),meta=compiler.translateWith(false);
 t.ok(meta.nativeObjectBodyFieldSites>0,'cleanup fixture contains a positive object-body proof');
 t.equal(compiler.nativeObjectBody,undefined,'whole-body proof graph releases');t.equal(compiler.nativeObjectFieldOperations,undefined,'field discovery graph releases');
 t.equal(compiler.instructionExitSites,undefined,'instruction-exit discovery set releases');
 if(global.gc){const weak=(()=>{const old=object(j,bytes(j,data));raw(read,[8,old]);return new WeakRef(old);})();
  for(let i=0;i<10;i++){await new Promise(setImmediate);global.gc();}t.equal(weak.deref(),undefined,'completed object collects while native modules remain live');
  const lazyWeak=(()=>{const a=object(j,bytes(j,[3])),b=object(j,bytes(j,[7]));raw(multiple,[a,b,2]);return [new WeakRef(a),new WeakRef(b)];})();
  for(let i=0;i<10;i++){await new Promise(setImmediate);global.gc();}
  for(const weak of lazyWeak)t.equal(weak.deref(),undefined,'first-use imports retain no completed receiver');}
 t.end();
});

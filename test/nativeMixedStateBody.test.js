'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm'),Frame=require('../src/core/frame'),Stack=require('../src/core/callStack');
const {newFields,makeObjectRef,writeField}=require('../src/core/objectModel');
const {allocMultiArray}=require('../src/instructions/object');
const {getOp,takeWasmReturnValue}=require('../src/jit/wasmShared');
const compile=require('./javaFixture').makeJavaFixtureCompiler('native-mixed-state-');
const bit='int b=MixedStream.data[MixedStream.cursor]>>MixedStream.bit&1;MixedStream.bit++;MixedStream.cursor+=MixedStream.bit>>3;MixedStream.bit&=7;';

test('readonly instance arrays compose with static state and a terminal reference read',async t=>{
 const classpath=compile(t,'MixedVectorProbe',`
 public class MixedVectorProbe {
  static int prefixes,initializedAt;static byte[] input;static float[][] nextRows;
  static int caught(MixedBook book){try{return book.vector().length;}catch(ArrayIndexOutOfBoundsException e){return -71;}}
  static int guarded(MixedBook book,int n){prefixes++;int sum=0;for(int i=0;i<n;i++)sum+=book.scalar();return sum;}
  static int caughtGuarded(MixedBook book){try{return guarded(book,1);}catch(NullPointerException e){return -91;}}
  static int scanVectors(MixedBook book,int n){prefixes++;int sum=0;for(int i=0;i<n;i++)sum+=(int)book.vector()[0];return sum;}
  static int caughtVectors(MixedBook book){try{return scanVectors(book,1);}catch(NullPointerException e){return -10-MixedStream.bit;}
   catch(ArrayIndexOutOfBoundsException e){return -20-MixedStream.bit;}}
  static void replaceRows(MixedBook book){book.vectors=nextRows;}
  static void checkpoint(MixedBook book,int i){replaceRows(book);MixedStream.bit=6;}
  static int scopedStore(MixedBook[] books,Object[] output,int n){MixedBook book=books[0];prefixes++;int sum=0;for(int i=0;i<n;i++){sum+=(int)book.vector()[0];output[0]=book;}return sum;}
  static int scopedCast(MixedBook[] books,Object foreign,int n){MixedBook book=books[0];prefixes++;int sum=0;for(int i=0;i<n;i++){sum+=(int)book.vector()[0];if(foreign instanceof MixedBook)sum+=0;}return sum;}
  static int scopedStable(MixedBook[] books,int n){MixedBook book=books[0];prefixes++;int sum=0;for(int i=0;i<n;i++)sum+=(int)book.vector()[0];return sum;}
  static int scanScoped(MixedBook[] books,int n){prefixes++;int sum=0;for(int i=0;i<n;i++){
   MixedBook book=books[0];float[] row=book.vector();sum+=(int)row[0];checkpoint(book,i);}return sum;}
  static int scanFlags(MixedBook book,int n){prefixes++;int sum=0;for(int i=0;i<n;i++)sum+=book.flagVector()[0]?1:0;return sum;}
 }
 class MixedStream {
  static byte[] data;static int cursor,bit;static {cursor=0;data=MixedVectorProbe.input;MixedVectorProbe.initializedAt=MixedVectorProbe.prefixes;}
  static int next(){${bit}return b;}
 }
 final class MixedBook {
  int[] tree;volatile int[] volatileTree;float[][] vectors;boolean[][] flags;
  final int scalar(){int at=0;while(tree[at]>=0)at=MixedStream.next()!=0?tree[at]:at+1;return ~tree[at];}
  final float[] vector(){return vectors[scalar()];}
  final boolean[] flagVector(){return flags[scalar()];}
  final int captured(int n){MixedVectorProbe.prefixes++;int[] old=tree;int sum=0;for(int i=0;i<n;i++){${bit}sum+=old[i]+b;}return sum;}
  final float[] volatileVector(){int at=0;while(volatileTree[at]>=0){${bit}at=b!=0?volatileTree[at]:at+1;}return vectors[~volatileTree[at]];}
  final int callbackThenStore(){int at=0;while(tree[at]>=0){${bit}at=b!=0?tree[at]:at+1;}float[] value=vectors[~tree[at]];MixedStream.bit++;return value.length;}
 }`);
 const j=new JVM({classpath,wasmHeap:true,wasmFields:true,prepareBeforeMain:false,
  jit:{enabled:false,compileWorker:false,retainCompilerDiagnostics:false,wasmStructured:true,
   wasm:{deepInline:false,canonicalDirectCalls:true,canonicalEhLinks:true,nativeJsExceptionTags:true}}});
 await j.preloadClasspathClasses();for(const name of ['MixedVectorProbe','MixedBook'])j._markClassInitialized(name);
 const w=j.jit.wasmJit;w.importStatsEnabled=true;
 const build=(owner,name,descriptor)=>{const method=j.findMethod(j.classes[owner],name,descriptor),state=w.methodState({method});
  // Exercise nested reconstruction when the ready wrapper has no paired-entry
  // proof. The default ready-proof boundary policy has its own call tests.
  const wrapped=w.state.get(j.findMethod(j.classes.MixedBook,'vector','()[F'))?.meta,proof=wrapped?.pairedNativeStorage;
  if(proof)wrapped.pairedNativeStorage=null;
  try{w.compile({method,className:owner},state,{asCallee:true});}
  finally{if(proof)wrapped.pairedNativeStorage=proof;}
  t.equal(state.status,'ready',state.lastCompileError||name+' compiles');return state;};
 build('MixedStream','next','()I');build('MixedBook','scalar','()I');
 const vector=build('MixedBook','vector','()[F'),captured=build('MixedBook','captured','(I)I'),
  vol=build('MixedBook','volatileVector','()[F'),later=build('MixedBook','callbackThenStore','()I'),caught=build('MixedVectorProbe','caught','(LMixedBook;)I'),
  guarded=build('MixedVectorProbe','guarded','(LMixedBook;I)I'),caughtGuarded=build('MixedVectorProbe','caughtGuarded','(LMixedBook;)I'),
  scanVectors=build('MixedVectorProbe','scanVectors','(LMixedBook;I)I'),caughtVectors=build('MixedVectorProbe','caughtVectors','(LMixedBook;)I'),
  scanFlags=build('MixedVectorProbe','scanFlags','(LMixedBook;I)I');
 build('MixedVectorProbe','replaceRows','(LMixedBook;)V');
 build('MixedVectorProbe','checkpoint','(LMixedBook;I)V');
 const scoped=build('MixedVectorProbe','scanScoped','([LMixedBook;I)I'),stable=build('MixedVectorProbe','scopedStable','([LMixedBook;I)I'),
  stored=build('MixedVectorProbe','scopedStore','([LMixedBook;[Ljava/lang/Object;I)I');
 const oldCheckcast=w.checkcastEnabled;w.checkcastEnabled=true;
 const casted=build('MixedVectorProbe','scopedCast','([LMixedBook;Ljava/lang/Object;I)I');w.checkcastEnabled=oldCheckcast;
 t.equal(vector.meta.inlineActivationSiteCount,1,'original scalar loop is actually inlined');
 t.equal(vector.meta.inlineAtomicStaticSiteCount,1,'inlined scalar retains its atomic reader');
 t.ok(vector.meta.nativeStaticStateBodySites>0,'mixed inlined reader earns the state proof');
 t.ok(vector.meta.nativeStaticStateInstanceFieldSites>0,'instance fields participate in the same proof');
 t.equal(vector.meta.nativeStaticStateTailLoadCount,1,'only the terminating reference read may call a foreign getter');
 t.notOk(vector.meta.closedNativeBody,'a terminal opaque read never publishes a callback-free contract');
 t.notOk(vector.meta.canonicalClosedStorageRun,'mixed tail method has no trusted closed export');
 t.equal(guarded.meta.inlineActivationSiteCount,1,'guarded state loop is actually flattened');
 t.ok(guarded.meta.nativeStaticStateBodySites>0,'synthetic guard and exact invoke exit retain the state proof');
 t.ok(guarded.meta.normalFlowFullyCompiled,'guard miss does not demote normal caller flow');
 t.notOk(guarded.meta.closedNativeBody,'a possible original-invoke exit has no closed body contract');
 t.equal(vol.meta.nativeStaticStateBodySites,0,'volatile field retains its ordinary access protocol');
 t.equal(later.meta.nativeStaticStateBodySites,0,'callback followed by more Java effects is not admitted');
 const stream=j.classes.MixedStream.staticFields,probe=j.classes.MixedVectorProbe.staticFields;
 const array=(type,values)=>{const a=j.wasmHeap.alloc(type,values.length);a.type=type;a.set(values);return a;};
 const book=()=>{const o=makeObjectRef(j,'MixedBook',newFields(j,'MixedBook'));
  writeField(o.fields,'MixedBook.tree',array('[I',[2,-1,-2]));return o;};
 const reset=(values=[1])=>{stream.set('data:[B',array('[B',values));stream.set('cursor:I',0);stream.set('bit:I',0);probe.set('prefixes:I',0);};
 const raw=(state,args,fuel=1e8)=>{const frame=new Frame(state.method);frame.className=state.key.split('.')[0];state.meta.paramSlots.forEach((p,i)=>frame.locals[p.slot]=args[i]);state.meta.box.frame=frame;
  try{const status=state.run(...args,0,fuel);return {frame,status,value:status===-1?takeWasmReturnValue(state.meta):undefined};}finally{state.meta.box.frame=null;}};
 const start=(state,args)=>{const frame=new Frame(state.method);frame.className=state.key.split('.')[0];state.meta.paramSlots.forEach((p,i)=>frame.locals[p.slot]=args[i]);
  const thread={id:0,status:'runnable',callStack:new Stack()};thread.callStack.push(frame);j.threads=[thread];j.currentThreadIndex=0;
  return {frame,thread,out:w.execute(frame,thread,state,0)};};
 const finish=async({thread,out})=>{if(thread.callStack.isEmpty())return out.value;let result,steps=0;
  while(!thread.callStack.isEmpty()&&++steps<50000){const f=thread.callStack.peek(),ins=f.instructions[f.pc++].instruction;
   if(/^[ilfda]return$/.test(getOp(ins)))result=f.stack.peek();
   if(ins)try{await j.executeInstruction(ins,f,thread);}catch(e){j.handleException(e,f.pc-1,thread);}}
  t.ok(thread.callStack.isEmpty(),'exact Java continuation completes');return result;};
 w.freezeCompilation();j.jit._syncCompileEnvironment={trace:false,assert:true};j.jit.markMainStarted();
 const coldOwner=book();writeField(coldOwner.fields,'MixedBook.tree',array('[I',[1]));
 reset([0]);probe.set('input:[B',array('[B',[0]));probe.set('initializedAt:I',-1);
 t.equal(raw(captured,[coldOwner,1]).status,0,'cold static owner refuses before the mixed prefix');
 t.equal(probe.get('prefixes:I'),0,'cold entry performs no guest prefix');
 t.equal(probe.get('initializedAt:I'),-1,'cold guard does not initialize the dependency');
 t.equal(await finish(start(captured,[coldOwner,1])),1,'cold mixed continuation runs the original field/read sequence');
 t.equal(probe.get('initializedAt:I'),1,'initializer observes the original completed prefix');
 const first=book(),v0=array('[F',[3]),v1=array('[F',[7]),vectors=Object.assign([v0,v1],{type:'[[F'});writeField(first.fields,'MixedBook.vectors',vectors);
 reset();t.equal(raw(vector,[first]).value,v1,'terminal reference preserves exact vector identity');t.equal(stream.get('bit:I'),1,'native loop commits its bit cursor');
 reset([255,255]);t.equal(raw(guarded,[first,8]).value,8,'guarded state loop returns all original scalar results');
 t.equal(stream.get('bit:I'),0,'guarded state loop retains its bit wrapping');t.equal(stream.get('cursor:I'),1,'guarded state loop retains its byte cursor');
 t.equal(probe.get('prefixes:I'),1,'guarded state loop preserves its original prefix once');
 t.equal(guarded.meta.box.pendingFrames,null,'successful specialized loop allocates no interpreter frames');
 reset();t.equal(await finish(start(caughtGuarded,[null])),-91,'null guarded state receiver reaches its original Java handler');
 t.equal(probe.get('prefixes:I'),1,'null guarded state fallback does not replay or skip the prefix');
 const ownedBook=book(),ownedRows=allocMultiArray(j,'[[F',[2,1]);ownedRows[0][0]=3;ownedRows[1][0]=7;
 writeField(ownedBook.fields,'MixedBook.vectors',ownedRows);
 t.equal(scanVectors.meta.inlineActivationDepth,2,'vector scan contains both recovered original scopes');
 t.ok(scanVectors.meta.nativeStaticCheckedReferenceLoads>0,'nonterminal vector reads retain the static-state proof');
 t.notOk(scanVectors.meta.closedNativeBody,'a possible foreign reference read is not a closed contract');
 reset([255]);t.equal(raw(scanVectors,[ownedBook,8]).value,56,'owned rows continue through the proved stateful scan');
 t.deepEqual([stream.get('bit:I'),stream.get('cursor:I'),probe.get('prefixes:I')],[0,1,1],
  'owned reference scan commits all scalar effects exactly');
 t.equal(scanVectors.meta.importStats.get('native_state_array_header')||0,0,'private element headers provide ownership without repeated queries');
 reset([255]);const originalRun=scanVectors.run;
 scanVectors.run=(...args)=>{args[args.length-1]=2;return originalRun(...args);};let pausedVectors;
 try{pausedVectors=start(scanVectors,[ownedBook,8]);}finally{scanVectors.run=originalRun;}
 t.equal(pausedVectors.thread.callStack.size(),3,'stateful vector fuel exit reconstructs both original scopes');
 const replacementRows=allocMultiArray(j,'[[F',[2,1]);replacementRows[1][0]=100;
 writeField(ownedBook.fields,'MixedBook.vectors',replacementRows);
 t.equal(await finish(pausedVectors),707,'first captured row survives a yield while later iterations observe replacement');
 t.equal(probe.get('prefixes:I'),1,'stateful vector resumption never replays its prefix');
 writeField(ownedBook.fields,'MixedBook.vectors',ownedRows);
 reset([255]);writeField(ownedBook.fields,'MixedBook.vectors',null);
 t.equal(await finish(start(caughtVectors,[ownedBook])),-11,'null reference container fails after the completed scalar traversal');
 t.equal(probe.get('prefixes:I'),1,'null container fallback retains the completed caller prefix');
 writeField(ownedBook.fields,'MixedBook.vectors',ownedRows);
 reset([255]);const foreignRow=[0];foreignRow.type='[F';let primitiveReads=0;
 Object.defineProperty(foreignRow,0,{configurable:true,get(){primitiveReads++;stream.set('bit:I',5);return 11;}});
 ownedRows[1]=foreignRow;const foreignRun=start(scanVectors,[ownedBook,1]);
 t.equal(primitiveReads,0,'unowned primitive row hands off before its getter');
 t.equal(await finish(foreignRun),11,'foreign row continues at the actual primitive read');
 t.equal(primitiveReads,1,'foreign primitive getter runs once');t.equal(stream.get('bit:I'),5,'compiled scalar state never overwrites the getter mutation');
 ownedRows[1]=array('[F',[7]);let referenceReads=0;
 Object.defineProperty(ownedRows,1,{configurable:true,get(){referenceReads++;stream.set('bit:I',6);return array('[F',[11]);}});
 reset([65]);const referenceRun=start(scanVectors,[ownedBook,2]);
 t.equal(referenceReads,0,'revoked reference array hands off before the original getter');
 t.equal(referenceRun.thread.callStack.peek().method.name,'vector','reference miss restores the actual wrapper at its array read');
 t.equal(await finish(referenceRun),22,'later traversal observes the preceding reference getter mutation');
 t.equal(referenceReads,2,'reference getter executes at each original array read');
 t.deepEqual([stream.get('bit:I'),probe.get('prefixes:I')],[6,1],'reference handoff preserves scalar mutation and prefix count');
 const scopedOwner=book(),scopedRows=allocMultiArray(j,'[[F',[2,1]),nextRows=allocMultiArray(j,'[[F',[2,1]);
 scopedRows[1][0]=7;nextRows[1][0]=100;writeField(scopedOwner.fields,'MixedBook.vectors',scopedRows);
 probe.set('nextRows:[[F',nextRows);const books=Object.assign([scopedOwner],{type:'[LMixedBook;'});
 t.equal(scoped.meta.inlineActivationDepth,2,'dynamic receiver still contains both original inline scopes');
 t.ok(scoped.meta.nativeStaticArrayRegions.length>0,'opaque surrounding calls retain a bounded scope proof');
 t.ok(scoped.meta.nativeStaticStateBodySites>0,'the scope retains its scalar state proof');
 t.notOk(scoped.meta.closedNativeBody,'a stateful scope never certifies its surrounding method');
 reset([255]);t.equal(raw(scoped,[books,3]).value,207,'each region entry reloads state after the outside Java call');
 t.equal(scoped.meta.importStats.get('abase')||0,0,'owned wrapper row headers cross the return join without base queries');
 t.equal(scoped.meta.importStats.get('alen0')||0,0,'owned wrapper row headers cross the return join without length queries');
 t.deepEqual([stream.get('bit:I'),probe.get('prefixes:I')],[6,1],'region state does not overwrite the outside callback or replay prefixes');
 reset([255]);t.equal(raw(scoped,[null,0]).value,0,'untaken region never touches its receiver container');
 writeField(scopedOwner.fields,'MixedBook.vectors',scopedRows);reset([255]);const scopeRun=scoped.run;
 scoped.run=(...args)=>{args[args.length-1]=2;return scopeRun(...args);};let scopePause;
 try{scopePause=start(scoped,[books,3]);}finally{scoped.run=scopeRun;}
 t.equal(scopePause.thread.callStack.size(),3,'scope fuel refusal reconstructs both original virtual frames');
 t.equal(await finish(scopePause),207,'scope continuation retains its captured receiver and subsequent calls');
 t.equal(probe.get('prefixes:I'),1,'scope fuel handoff preserves the completed caller prefix');
 const stableOwner=book(),stableRows=allocMultiArray(j,'[[F',[2,1]),stableBooks=allocMultiArray(j,'[LMixedBook;',[1]);
 stableRows[1][0]=7;stableBooks[0]=stableOwner;writeField(stableOwner.fields,'MixedBook.vectors',stableRows);reset([255]);
 t.ok(stable.meta.nativeStaticArrayRegions.length>0,'stable captured receiver still uses the bounded scope proof');
 t.equal(raw(stable,[stableBooks,8]).value,56,'reused ownership leaves scalar state and rows exact');
 t.equal(stable.meta.importStats.get('native_state_object_storage'),1,'stable SSA receiver authenticates private storage once across scopes');
 reset([255]);t.equal(raw(stable,[stableBooks,8]).value,56,'a fresh invocation preserves the same owned result');
 const mutatedTree=stableOwner.fields['MixedBook.tree'];let mutatedReads=0,stableCallbacks=0;
 const callbackRows=Object.assign([array('[F',[3]),array('[F',[11])],{type:'[[F'});
 Object.defineProperty(callbackRows,1,{configurable:true,get(){if(!stableCallbacks++){
  Object.defineProperty(stableOwner.fields,'MixedBook.tree',{configurable:true,get(){mutatedReads++;return mutatedTree;}});
 }return array('[F',[11]);}});
 writeField(stableOwner.fields,'MixedBook.vectors',callbackRows);reset([255]);const mutated=start(stable,[stableBooks,4]);
 t.equal(mutated.thread.callStack.size(),2,'opaque callback revokes reused ownership before the next wrapper');
 t.equal(mutatedReads,0,'re-authentication refuses before executing a new host field getter');
 t.equal(await finish(mutated),44,'later iterations execute the customized original traversal');
 t.equal(mutatedReads,12,'every subsequent original tree access stays observable');
 t.equal(stableCallbacks,4,'reused ownership never skips a foreign reference getter');
 t.equal(probe.get('prefixes:I'),1,'ownership revocation preserves the completed outer prefix');
 for(const kind of ['terminal getter','metadata getter']){
  const receiver=book(),table=allocMultiArray(j,'[[F',[2,1]),container=allocMultiArray(j,'[LMixedBook;',[1]);table[1][0]=7;container[0]=receiver;
  const bitCell=stream.cell('bit:I');let current=0,bitReads=0,events=0;
  const callback=()=>{if(!events++){current=stream.get('bit:I');Object.defineProperty(bitCell,'value',{configurable:true,
   get(){bitReads++;return current;},set(value){current=value;}});}};
  let rows=table;
  if(kind==='terminal getter'){
   rows=Object.assign([table[0],table[1]],{type:'[[F'});Object.defineProperty(rows,1,{configurable:true,get(){callback();return table[1];}});
  }else{
   const view=new Float32Array(j.wasmHeap.memory.buffer,table[1].byteOffset,1);view.type='[F';view.wasmBase=view.byteOffset;
   Object.defineProperty(view,'length',{get(){callback();return 1;}});table[1]=view;
  }
  writeField(receiver.fields,'MixedBook.vectors',rows);reset([255]);const yielded=start(stable,[container,3]);
  t.equal(yielded.thread.callStack.size(),2,kind+' invalidates cached static permissions before the next scope');
  t.equal(bitReads,0,kind+' permission refusal executes no customized scalar getter');
  t.equal(await finish(yielded),21,kind+' resumes through original scalar accessors');
  t.equal(bitReads,8,kind+' preserves four scalar reads per remaining original traversal');
  t.equal(current,3,kind+' keeps every original scalar store');
  t.ok(events>=3,kind+' remains observable at later row accesses');
  t.equal(probe.get('prefixes:I'),1,kind+' permission handoff never replays its caller prefix');
  Object.defineProperty(bitCell,'value',{configurable:true,writable:true,value:current});
 }
 for(const kind of ['array setter','cast type getter','metadata getter']){
  const receiver=book(),table=allocMultiArray(j,'[[F',[2,1]),container=allocMultiArray(j,'[LMixedBook;',[1]);table[1][0]=7;
  container[0]=receiver;writeField(receiver.fields,'MixedBook.vectors',table);
  const originalTree=receiver.fields['MixedBook.tree'];let events=0,reads=0;
  const callback=()=>{if(!events++)Object.defineProperty(receiver.fields,'MixedBook.tree',{configurable:true,get(){reads++;return originalTree;}});};
  const output=Object.assign([null],{type:'[Ljava/lang/Object;'});Object.defineProperty(output,0,{configurable:true,set:callback});
  const foreign={get type(){callback();return 'MixedBook';}};
  if(kind==='metadata getter'){
   const view=new Float32Array(j.wasmHeap.memory.buffer,table[1].byteOffset,1);view.type='[F';view.wasmBase=view.byteOffset;
   Object.defineProperty(view,'length',{get(){callback();return 1;}});table[1]=view;
  }
  reset([255]);const yielded=kind==='metadata getter'?start(stable,[container,3]):
   start(kind==='array setter'?stored:casted,[container,kind==='array setter'?output:foreign,3]);
  t.equal(yielded.thread.callStack.size(),2,kind+' revokes ownership before the next region');
  t.equal(reads,0,kind+' does not invoke the customized field during authentication');
  t.equal(await finish(yielded),21,kind+' resumes the exact remaining Java traversal');
  t.equal(reads,8,kind+' preserves every subsequent original field read');
  t.ok(events>=3,kind+' still executes its original callbacks');
  t.equal(probe.get('prefixes:I'),1,kind+' handoff retains the completed prefix once');
 }
 const terminalRows=Object.assign([array('[F',[3]),array('[F',[11])],{type:'[[F'});let terminalReads=0;
 Object.defineProperty(terminalRows,1,{configurable:true,get(){terminalReads++;stream.set('bit:I',5);return array('[F',[11]);}});
 writeField(scopedOwner.fields,'MixedBook.vectors',terminalRows);probe.set('nextRows:[[F',terminalRows);reset([255]);
 t.equal(scoped.meta.nativeStaticStateTailLoadCount,1,'wrapper return ends the regional proof before the caller continues');
 t.equal(raw(scoped,[books,2]).value,22,'terminal foreign rows continue in the native caller after their checked getter');
 t.equal(terminalReads,2,'each terminal foreign getter executes once');
 t.equal(scoped.meta.box.pendingFrames,null,'a terminal region getter causes no avoidable interpreter handoff');
 t.deepEqual([stream.get('bit:I'),probe.get('prefixes:I')],[6,1],'outside continuation observes terminal getter effects and completes once');
 const terminalError={type:'java/lang/RuntimeException',message:'scope terminal getter'};
 Object.defineProperty(terminalRows,1,{configurable:true,get(){throw terminalError;}});reset([255]);
 t.throws(()=>raw(scoped,[books,1]),error=>error===terminalError,'terminal scope getter preserves throwable identity');
 t.deepEqual([stream.get('bit:I'),probe.get('prefixes:I')],[1,1],'terminal throw retains completed stores and skips the outside call');
 const alias=new Float32Array(j.wasmHeap.memory.buffer,scopedRows[1].byteOffset,1);alias.type='[F';alias.wasmBase=alias.byteOffset;let aliasLengthReads=0;
 Object.defineProperty(alias,'length',{get(){aliasLengthReads++;return 1;}});
 const aliasRows=allocMultiArray(j,'[[F',[2,1]);aliasRows[1]=alias;
 writeField(scopedOwner.fields,'MixedBook.vectors',aliasRows);probe.set('nextRows:[[F',aliasRows);reset([255]);
 t.equal(raw(scoped,[books,2]).value,14,'untracked views retain ordinary checked element access outside the scope');
 t.equal(aliasLengthReads,2,'unowned positive pointers never become phi ownership certificates');
 probe.set('nextRows:[[F',nextRows);
 writeField(scopedOwner.fields,'MixedBook.vectors',scopedRows);reset([255]);let scopedFieldReads=0;
 const scopedTree=scopedOwner.fields['MixedBook.tree'];
 Object.defineProperty(scopedOwner.fields,'MixedBook.tree',{configurable:true,get(){scopedFieldReads++;return scopedTree;}});
 const scopedForeign=start(scoped,[books,1]);
 t.equal(scopedFieldReads,0,'region authentication refuses before a customized field getter');
 t.equal(scopedForeign.thread.callStack.size(),2,'entry refusal materializes only the actual wrapper, before scalar invocation');
 t.equal(scopedForeign.thread.callStack.peek().pc,0,'region refusal resumes at the original wrapper entry');
 t.equal(stream.get('bit:I'),0,'region refusal commits no scalar traversal stores');
 t.equal(await finish(scopedForeign),7,'custom fields follow their original nested Java code');
 t.equal(scopedFieldReads,4,'custom tree getter retains its original access count');
 t.deepEqual([stream.get('bit:I'),probe.get('prefixes:I')],[6,1],'original callback continuation preserves caller effects once');
 Object.defineProperty(scopedOwner.fields,'MixedBook.tree',{configurable:true,writable:true,value:scopedTree});
 const booleanRows=allocMultiArray(j,'[[Z',[2,1]);booleanRows[1][0]=true;
 writeField(ownedBook.fields,'MixedBook.flags',booleanRows);reset([255]);
 t.ok(scanFlags.meta.nativeStaticCheckedReferenceLoads>0,'boolean row case reaches the same reference proof');
 const booleanRun=start(scanFlags,[ownedBook,1]);
 t.ok(!booleanRun.thread.callStack.isEmpty(),'boolean element retains its representation fallback');
 t.equal(await finish(booleanRun),1,'boolean fallback preserves Java baload normalization');
 t.equal(stream.get('bit:I'),1,'boolean fallback retains completed scalar effects');
 let tailCalls=0;Object.defineProperty(vectors,1,{configurable:true,get(){tailCalls++;stream.set('bit:I',6);return v1;}});
 reset();t.equal(raw(vector,[first]).value,v1,'terminal foreign getter returns its original value');
 t.equal(tailCalls,1,'terminal getter executes once');t.equal(stream.get('bit:I'),6,'no cached scalar overwrites a terminal callback effect');
 reset();t.equal(raw(later,[first]).value,1,'rejected nonterminal callback path retains its original result');
 t.equal(stream.get('bit:I'),7,'Java effects after an opaque read observe its mutation');
 const error={type:'java/lang/RuntimeException',message:'terminal getter'};
 Object.defineProperty(vectors,1,{configurable:true,get(){throw error;}});
 reset();t.throws(()=>raw(vector,[first]),value=>value===error,'terminal host throw preserves its original identity');
 t.equal(stream.get('bit:I'),1,'terminal throw retains all completed scalar writes');
 Object.defineProperty(vectors,1,{configurable:true,writable:true,value:v1});
 reset([]);t.equal(await finish(start(caught,[first])),-71,'byte bounds failure reaches the original outer handler');t.equal(stream.get('bit:I'),0,'failed refill commits no later cursor store');
 reset();writeField(first.fields,'MixedBook.tree',array('[I',[2,-5,-5]));
 t.equal(await finish(start(caught,[first])),-71,'terminal bounds failure reaches the original outer handler');t.equal(stream.get('bit:I'),1,'terminal failure retains completed reader effects');
 writeField(first.fields,'MixedBook.tree',array('[I',[2,-1,-2]));
 let fieldGetters=0;const originalTree=first.fields['MixedBook.tree'];Object.defineProperty(first.fields,'MixedBook.tree',{configurable:true,get(){fieldGetters++;return originalTree;}});
 reset();const denied=raw(vector,[first]);t.equal(denied.status,0,'custom instance field refuses before the native prefix');t.equal(fieldGetters,0,'entry authentication invokes no custom getter');
 t.equal(await finish(start(vector,[first])),v1,'custom field uses its original Java continuation');t.ok(fieldGetters>0,'fallback invokes the original field getter');delete first.fields['MixedBook.tree'];
 reset([0]);const owner=book(),old=array('[I',[1,2,3,4]);writeField(owner.fields,'MixedBook.tree',old);
 t.ok(captured.meta.nativeStaticStateBodySites>0,'captured instance array earns the mixed proof');
 t.ok(captured.meta.structuredResumeEntry,'captured mixed loop retains an original resume header');
 const paused=raw(captured,[owner,4],2);paused.frame.pc=paused.status;
 t.equal(paused.status,captured.meta.structuredResumeEntry.item,'fuel exits at the original loop header');
 writeField(owner.fields,'MixedBook.tree',array('[I',[100,100,100,100]));
 const thread={id:0,status:'runnable',callStack:new Stack()};thread.callStack.push(paused.frame);j.threads=[thread];j.currentThreadIndex=0;
 const out=w.execute(paused.frame,thread,captured,captured.meta.structuredResumeEntry.block);
 t.equal(out.value,10,'native resumption authenticates the restored original array value');
 t.ok(thread.callStack.isEmpty(),'owned capture resumes without interpreter handoff');t.equal(probe.get('prefixes:I'),1,'native resumption does not replay its prefix');
 t.equal(j.jit.syncCompileCensus().postMainSyncCompileCount,0,'mixed faults, initialization and resumption compile no guest methods');
 t.end();
});

test('a later subclass leaves a guarded state body at the exact original invoke',async t=>{
 const classpath=compile(t,'GuardedStateProbe',`
 public class GuardedStateProbe {
  static int prefixes,tails;
  static int run(GuardedStateBase book,int n){prefixes++;int sum=0;for(int i=0;i<n;i++)sum+=book.scan();tails++;return sum;}
 }
 class GuardedStateStream {static byte[] data;static int bit,cursor;}
 class GuardedStateBase {int[] tree;
  final int scan(){int at=0;while(tree[at]>=0){
   int bit=GuardedStateStream.data[GuardedStateStream.cursor]>>GuardedStateStream.bit&1;
   GuardedStateStream.bit++;GuardedStateStream.cursor+=GuardedStateStream.bit>>3;GuardedStateStream.bit&=7;
   at=bit!=0?tree[at]:at+1;}return ~tree[at];}
 }
 final class GuardedStateLate extends GuardedStateBase {}`);
 const j=new JVM({classpath,wasmHeap:true,wasmFields:true,prepareBeforeMain:false,
  jit:{enabled:false,compileWorker:false,retainCompilerDiagnostics:false,wasmStructured:true,
   wasm:{deepInline:false,canonicalDirectCalls:true,canonicalEhLinks:true,nativeJsExceptionTags:true}}});
 for(const owner of ['GuardedStateProbe','GuardedStateStream','GuardedStateBase']){
  await j.loadClassByName(owner);j._markClassInitialized(owner);
 }
 t.notOk(j.classes.GuardedStateLate,'subclass is genuinely absent during compilation');
 const w=j.jit.wasmJit,method=j.findMethod(j.classes.GuardedStateProbe,'run','(LGuardedStateBase;I)I'),state=w.methodState({method});
 w.compile({method,className:'GuardedStateProbe'},state,{asCallee:true});
 t.equal(state.status,'ready',state.lastCompileError||'guarded state caller compiles');
 t.ok(state.meta.nativeStaticStateBodySites>0,'caller has the guarded state proof before loading the subclass');
 t.equal(state.meta.specSites.length,0,'a final method needs no class-epoch speculation');
 t.equal(state.meta.speculations,0,'a checked final-method miss is not an unchecked speculation');
 t.ok(require('../src/jit/CanonicalDirectFrames').CanonicalDirectLinks.eligible(state),
  'guarded fixed-dispatch state body remains eligible for native canonical callers');
 await j.loadClassByName('GuardedStateLate');j._markClassInitialized('GuardedStateLate');
 const array=(type,values)=>{const a=j.wasmHeap.alloc(type,values.length);a.type=type;a.set(values);return a;};
 const book=makeObjectRef(j,'GuardedStateLate',newFields(j,'GuardedStateLate'));
 writeField(book.fields,'GuardedStateBase.tree',array('[I',[2,-1,-2]));
 const stream=j.classes.GuardedStateStream.staticFields,fields=j.classes.GuardedStateProbe.staticFields;
 stream.set('data:[B',array('[B',[255]));stream.set('bit:I',0);stream.set('cursor:I',0);fields.set('prefixes:I',0);fields.set('tails:I',0);
 const frame=new Frame(method),carrier=new Frame(method);frame.className='GuardedStateProbe';frame.locals[0]=book;frame.locals[1]=2;
 w.freezeCompilation();j.jit._syncCompileEnvironment={trace:false,assert:true};j.jit.markMainStarted();
 state.meta.box.frame=frame;let status;
 try{status=state.run(book,2,0,100000000);}finally{state.meta.box.frame=null;}
 const invoke=method.attributes.find(a=>a.type==='code').code.codeItems.findIndex(item=>item.instruction?.op==='invokevirtual');
 t.equal(status,invoke,'unknown native class resumes at the original method invocation');
 t.equal(fields.get('prefixes:I'),1,'completed caller prefix is not undone');t.equal(fields.get('tails:I'),0,'caller tail has not run');
 t.equal(stream.get('bit:I'),0,'the unknown class path has run no inlined callee effects');
 t.equal(frame.stack.peek(),book,'original receiver is reconstructed on the operand stack');
 frame.pc=status;const thread={id:0,status:'runnable',callStack:new Stack()};thread.callStack.push(carrier);thread.callStack.push(frame);
 j.threads=[thread];j.currentThreadIndex=0;
 for(let steps=0;thread.callStack.size()>1&&steps<5000;steps++){
  const f=thread.callStack.peek(),at=f.pc++,ins=f.instructions[at].instruction;
  if(ins)try{await j.executeInstruction(ins,f,thread);}catch(error){j.handleException(error,at,thread);}
 }
 t.equal(thread.callStack.size(),1,'original invoke continuation completes');t.equal(carrier.stack.pop(),2,'later subclass retains inherited Java dispatch');
 t.equal(fields.get('prefixes:I'),1,'later-class handoff never replays the prefix');t.equal(fields.get('tails:I'),1,'later-class handoff executes the tail once');
 t.equal(stream.get('bit:I'),2,'each original child commits exactly one bit');
 t.equal(j.jit.syncCompileCensus().postMainSyncCompileCount,0,'late-class continuation compiles no Java methods');t.end();
});

test('a cold dependency inside a native inline scope initializes after the caller prefix',async t=>{
 const classpath=compile(t,'ColdScopeProbe',`
 public class ColdScopeProbe {
  static int prefix,initializedAt=-1;static byte[] input;
  static int run(ColdScopeBook[] books){prefix++;return books[0].vector()[0];}
 }
 class ColdScopeStream {static byte[] data;static int bit,cursor;
  static {data=ColdScopeProbe.input;ColdScopeProbe.initializedAt=ColdScopeProbe.prefix;}
 }
 final class ColdScopeBook {int[] tree;int[][] rows;
  final int scalar(){int at=0;while(tree[at]>=0){
   int b=ColdScopeStream.data[ColdScopeStream.cursor]>>ColdScopeStream.bit&1;
   ColdScopeStream.bit++;ColdScopeStream.cursor+=ColdScopeStream.bit>>3;ColdScopeStream.bit&=7;
   at=b!=0?tree[at]:at+1;}return ~tree[at];}
  final int[] vector(){return rows[scalar()];}
 }`);
 const j=new JVM({classpath,wasmHeap:true,wasmFields:true,prepareBeforeMain:false,
  jit:{enabled:false,compileWorker:false,retainCompilerDiagnostics:false,wasmStructured:true,
   wasm:{deepInline:false,canonicalDirectCalls:true,canonicalEhLinks:true,nativeJsExceptionTags:true}}});
 await j.preloadClasspathClasses();for(const name of ['ColdScopeProbe','ColdScopeBook'])j._markClassInitialized(name);
 const w=j.jit.wasmJit,method=j.findMethod(j.classes.ColdScopeProbe,'run','([LColdScopeBook;)I'),state=w.methodState({method});
 w.compile({method,className:'ColdScopeProbe'},state,{asCallee:true});
 t.equal(state.status,'ready',state.lastCompileError||'cold scope compiles');
 t.ok(state.meta.nativeStaticArrayRegions.length,'cold dependency is guarded at an inline scope');
 const input=j.wasmHeap.alloc('[B',1);input.type='[B';input[0]=255;
 const tree=j.wasmHeap.alloc('[I',3);tree.type='[I';tree.set([2,-1,-2]);
 const rows=allocMultiArray(j,'[[I',[2,1]);rows[1][0]=7;
 const book=makeObjectRef(j,'ColdScopeBook',newFields(j,'ColdScopeBook'));
 writeField(book.fields,'ColdScopeBook.tree',tree);writeField(book.fields,'ColdScopeBook.rows',rows);
 const fields=j.classes.ColdScopeProbe.staticFields;fields.set('input:[B',input);fields.set('initializedAt:I',-1);fields.set('prefix:I',0);
 const frame=new Frame(method);frame.className='ColdScopeProbe';frame.locals[0]=Object.assign([book],{type:'[LColdScopeBook;'});
 const thread={id:0,status:'runnable',callStack:new Stack()};thread.callStack.push(frame);j.threads=[thread];j.currentThreadIndex=0;
 w.freezeCompilation();j.jit._syncCompileEnvironment={trace:false,assert:true};j.jit.markMainStarted();
 w.execute(frame,thread,state,0);
 t.equal(fields.get('prefix:I'),1,'caller prefix completes before cold scope refusal');
 t.equal(fields.get('initializedAt:I'),-1,'side-effect-free guard has not initialized the dependency');
 t.equal(thread.callStack.size(),2,'cold guard resumes at wrapper entry before creating a scalar frame');
 t.equal(thread.callStack.peek().pc,0,'the unstarted wrapper retains its original PC');
 let result,steps=0;
 while(!thread.callStack.isEmpty()&&++steps<50000){const f=thread.callStack.peek(),at=f.pc++,ins=f.instructions[at].instruction;
  if(getOp(ins)==='ireturn')result=f.stack.peek();
  if(ins)try{await j.executeInstruction(ins,f,thread);}catch(error){j.handleException(error,at,thread);}}
 t.ok(thread.callStack.isEmpty(),'cold original continuation completes');t.equal(result,7,'cold scope returns the exact row element');
 t.equal(fields.get('initializedAt:I'),1,'initializer observes the completed original prefix');
 t.equal(fields.get('prefix:I'),1,'cold scope handoff does not replay the caller prefix');
 t.equal(j.classes.ColdScopeStream.staticFields.get('bit:I'),1,'original traversal commits exactly one bit');
 t.equal(j.jit.syncCompileCensus().postMainSyncCompileCount,0,'cold original continuation compiles no guest method');t.end();
});

'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm'),Frame=require('../src/core/frame'),Stack=require('../src/core/callStack');
const {newFields,makeObjectRef,writeField}=require('../src/core/objectModel');
const {getOp,takeWasmReturnValue}=require('../src/jit/wasmShared');
const compile=require('./javaFixture').makeJavaFixtureCompiler('native-mixed-state-');
const bit='int b=MixedStream.data[MixedStream.cursor]>>MixedStream.bit&1;MixedStream.bit++;MixedStream.cursor+=MixedStream.bit>>3;MixedStream.bit&=7;';

test('readonly instance arrays compose with static state and a terminal reference read',async t=>{
 const classpath=compile(t,'MixedVectorProbe',`
 public class MixedVectorProbe {
  static int prefixes,initializedAt;static byte[] input;
  static int caught(MixedBook book){try{return book.vector().length;}catch(ArrayIndexOutOfBoundsException e){return -71;}}
  static int guarded(MixedBook book,int n){prefixes++;int sum=0;for(int i=0;i<n;i++)sum+=book.scalar();return sum;}
  static int caughtGuarded(MixedBook book){try{return guarded(book,1);}catch(NullPointerException e){return -91;}}
 }
 class MixedStream {
  static byte[] data;static int cursor,bit;static {cursor=0;data=MixedVectorProbe.input;MixedVectorProbe.initializedAt=MixedVectorProbe.prefixes;}
  static int next(){${bit}return b;}
 }
 final class MixedBook {
  int[] tree;volatile int[] volatileTree;float[][] vectors;
  final int scalar(){int at=0;while(tree[at]>=0)at=MixedStream.next()!=0?tree[at]:at+1;return ~tree[at];}
  final float[] vector(){return vectors[scalar()];}
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
  w.compile({method,className:owner},state,{asCallee:true});t.equal(state.status,'ready',state.lastCompileError||name+' compiles');return state;};
 build('MixedStream','next','()I');build('MixedBook','scalar','()I');
 const vector=build('MixedBook','vector','()[F'),captured=build('MixedBook','captured','(I)I'),
  vol=build('MixedBook','volatileVector','()[F'),later=build('MixedBook','callbackThenStore','()I'),caught=build('MixedVectorProbe','caught','(LMixedBook;)I'),
  guarded=build('MixedVectorProbe','guarded','(LMixedBook;I)I'),caughtGuarded=build('MixedVectorProbe','caughtGuarded','(LMixedBook;)I');
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

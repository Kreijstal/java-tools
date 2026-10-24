'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm'),Frame=require('../src/core/frame'),Stack=require('../src/core/callStack');
const {getOp,takeWasmReturnValue}=require('../src/jit/wasmShared');
const compile=require('./javaFixture').makeJavaFixtureCompiler('native-static-state-');

test('one static-state body keeps exact stores, checked fallback and native resumption',async t=>{
 const classpath=compile(t,'StaticStateReader',`
 public class StaticStateReader {
  static byte[] data;static int byteCursor,bitCursor,prefixes,steps;
  static volatile int volatileCursor;
  static int readBits(int n){int result=0,shift=0;while(n>=8-bitCursor){int bits=8-bitCursor,mask=(1<<bits)-1;
   result+=((data[byteCursor]>>bitCursor&mask)<<shift);bitCursor=0;byteCursor++;shift+=bits;n-=bits;}
   if(n>0){result+=(data[byteCursor]>>bitCursor&((1<<n)-1))<<shift;bitCursor+=n;}return result;}
  static int readOne(){int result=data[byteCursor]>>bitCursor&1;bitCursor++;byteCursor+=bitCursor>>3;bitCursor&=7;return result;}
  static int wrapped(int n){int sum=0;for(int i=0;i<n;i++)sum=sum*33+readOne();return sum;}
  static int caughtWrapped(int n){try{return wrapped(n);}catch(ArrayIndexOutOfBoundsException e){return -71;}}
  static int captured(int n){prefixes++;byte[] old=data;int sum=0;for(int i=0;i<n;i++){steps++;byteCursor++;bitCursor++;sum+=old[i];}return sum;}
  static int cold(int n){prefixes++;byteCursor++;for(int i=0;i<n;i++){bitCursor++;steps++;byteCursor+=ColdStateData.data[i];}return byteCursor;}
  static int volatileRead(int n){for(int i=0;i<n;i++){volatileCursor++;byteCursor++;bitCursor+=data[i];}return bitCursor;}
  static int budget(int n){for(int i=0;i<n;i++){${'byteCursor+=data[0];bitCursor++;'.repeat(70)}}return bitCursor;}
  static int caught(int n){try{return readBits(n);}catch(ArrayIndexOutOfBoundsException e){return -71;}catch(NullPointerException e){return -72;}}
 }
 class ColdStateData {static byte[] data={2,3};static int observed=StaticStateReader.prefixes;}`);
 const j=new JVM({classpath,wasmHeap:true,wasmFields:true,wasmHeapMb:1,prepareBeforeMain:false,
  jit:{codegen:true,compileWorker:false,retainCompilerDiagnostics:false,
   wasm:{structured:true,canonicalDirectCalls:true,canonicalEhLinks:true,nativeJsExceptionTags:true}}});
 await j.preloadClasspathClasses();j._markClassInitialized('StaticStateReader');
 const w=j.jit.wasmJit;w.enabled=true;w.importStatsEnabled=true;
 const build=(name,descriptor='(I)I')=>{const method=j.findMethod(j.classes.StaticStateReader,name,descriptor),state=w.methodState({method});
  w.compile({method,className:'StaticStateReader'},state,{asCallee:true});t.equal(state.status,'ready',state.lastCompileError||name+' compiles');return state;};
 const read=build('readBits'),one=build('readOne','()I'),wrapped=build('wrapped'),caughtWrapped=build('caughtWrapped'),captured=build('captured'),cold=build('cold'),vol=build('volatileRead'),budget=build('budget'),caught=build('caught');
 for(const state of [read,one,captured,cold])t.ok(state.meta.nativeStaticStateBodySites>0,state.key+' selects the proved static-state body');
 t.equal(vol.meta.nativeStaticStateBodySites,0,'volatile scalar cells are excluded');
 t.equal(budget.meta.nativeStaticStateBodySites,0,'proof exhaustion retains ordinary compilation');
 t.equal(caught.meta.nativeStaticStateBodySites,0,'local exception handlers keep their supported path');
 const fields=j.classes.StaticStateReader.staticFields;
 const array=values=>{const a=j.wasmHeap.alloc('[B',values.length);a.type='[B';a.set(values);return a;};
 const reset=values=>{fields.set('data:[B',values);for(const key of ['byteCursor','bitCursor','prefixes','steps'])fields.set(key+':I',0);};
 const raw=(state,args=[],fuel=1e8)=>{const frame=new Frame(state.method);frame.className='StaticStateReader';args.forEach((v,i)=>frame.locals[i]=v);state.meta.box.frame=frame;
  try{const status=state.run(...args,0,fuel);return {frame,status,value:status===-1?takeWasmReturnValue(state.meta):undefined};}finally{state.meta.box.frame=null;}};
 const start=(state,args=[])=>{const frame=new Frame(state.method);frame.className='StaticStateReader';args.forEach((v,i)=>frame.locals[i]=v);
  const thread={id:0,status:'runnable',callStack:new Stack(),pendingException:null};thread.callStack.push(frame);j.threads=[thread];j.currentThreadIndex=0;
  const out=w.execute(frame,thread,state,0);return {frame,thread,out};};
 const finish=async({thread,out})=>{if(thread.callStack.isEmpty())return out.value;let value,steps=0;
  const wasEnabled=j.jit.enabled;j.jit.enabled=false;
  try{while(!thread.callStack.isEmpty()&&++steps<50000){const frame=thread.callStack.peek(),ins=frame.instructions[frame.pc++].instruction;
   if(/^[ilfda]return$/.test(getOp(ins)))value=frame.stack.peek();
   if(ins)try{await j.executeInstruction(ins,frame,thread);}catch(error){j.handleException(error,frame.pc-1,thread);}}
  }finally{j.jit.enabled=wasEnabled;}
  t.ok(thread.callStack.isEmpty(),'exact Java continuation completes');return value;};
 reset(array([0x53,0x2a]));t.equal(raw(read,[12]).value,0xa53,'native static reader retains bit order');
 t.equal(fields.get('byteCursor:I'),1,'completed byte is visible in canonical static storage');t.equal(fields.get('bitCursor:I'),4,'partial byte cursor is exact');
 reset(array([0x53]));fields.set('bitCursor:I',true);
 t.equal(raw(read,[0]).status,0,'non-numeric host representation retains its checked path');
 t.equal(await finish(start(read,[0])),0,'untaken integer writes do not coerce a host boolean');
 t.equal(fields.get('bitCursor:I'),true,'zero-trip fallback preserves the exact original representation');
 t.equal(await finish(start(one)),1,'checked Java stores convert the host input at the original instruction');
 t.equal(fields.get('bitCursor:I'),2,'completed Java int store restores canonical numeric representation');
 fields.set('bitCursor:I',-0);t.equal(raw(read,[0]).status,0,'negative-zero host representation also refuses early');
 t.equal(await finish(start(read,[0])),0,'negative-zero input retains the original zero-trip result');
 t.ok(Object.is(fields.get('bitCursor:I'),-0),'untaken store preserves negative zero');
 reset(array([0x53]));t.equal(raw(one).value,1,'acyclic state update also selects the one native body');
 t.equal(fields.get('bitCursor:I'),1,'acyclic scalar writes are immediate');
 reset(array([0x53,0x2a]));let wrappedExpected=0;for(let i=0;i<12;i++)wrappedExpected=(Math.imul(wrappedExpected,33)+([0x53,0x2a][i>>3]>>(i&7)&1))|0;
 t.ok(wrapped.meta.inlinedCalls>0,'fixture actually flattens its static reader');
 t.ok(wrapped.meta.nativeStaticStateBodySites>0,'flattened callback-free reader earns the same static-state proof');
 t.equal(raw(wrapped,[12]).value,wrappedExpected,'flattened scalar state preserves all original reads and writes');
 reset(array([0x53,0x2a]));t.equal(await finish(start(caughtWrapped,[20])),-71,'inline reader exception reaches the original outer handler');
 t.equal(fields.get('byteCursor:I'),2,'inline failure keeps exactly the completed byte advances');
 t.equal(fields.get('bitCursor:I'),0,'inline failure applies no later cursor increment');
 reset(array([0x53,0x2a]));const wrappedPause=raw(wrapped,[12],2);wrappedPause.frame.pc=wrappedPause.status;
 t.ok(wrapped.meta.structuredResumeEntry,'flattened state body retains its caller resume header');
 t.equal(wrappedPause.status,wrapped.meta.structuredResumeEntry.item,'flattened fuel exit has an original Java PC');
 const wrappedThread={id:0,status:'runnable',callStack:new Stack(),pendingException:null};wrappedThread.callStack.push(wrappedPause.frame);j.threads=[wrappedThread];j.currentThreadIndex=0;
 const wrappedOut=w.execute(wrappedPause.frame,wrappedThread,wrapped,wrapped.meta.structuredResumeEntry.block);
 t.equal(wrappedOut.value,wrappedExpected,'native inline resume reloads current static values without replay');
 t.ok(wrappedThread.callStack.isEmpty(),'native inline resume completes without interpreter handoff');
 reset(array([7]));t.equal(await finish(start(caught,[16])),-71,'bounds failure reaches the original caller handler');
 t.equal(fields.get('byteCursor:I'),1,'failed refill preserves exactly the completed first iteration');
 t.equal(fields.get('bitCursor:I'),0,'failed refill does not apply its later writes');
 reset(null);t.equal(await finish(start(caught,[0])),0,'unused null array remains legal through entry fallback');
 t.equal(await finish(start(caught,[1])),-72,'used null array reaches the original null handler');
 reset(Object.assign([0x53,0x2a],{type:'[B'}));t.equal(await finish(start(read,[12])),0xa53,'foreign arrays retain correct checked execution');
 reset(array([0x53,0x2a]));const cursor=fields.cell('bitCursor:I');let gets=0,sets=0,current=0;
 Object.defineProperty(cursor,'value',{configurable:true,get(){gets++;return current;},set(v){sets++;current=v;}});
 const denied=raw(read,[12]);t.equal(denied.status,0,'custom cell refuses before guest effects');t.equal(gets,0,'entry guard invokes no getter');t.equal(sets,0,'entry guard invokes no setter');
 t.equal(await finish(start(read,[12])),0xa53,'custom cell fallback preserves the original computation');t.ok(gets>0&&sets>0,'fallback invokes the original accessors');
 Object.defineProperty(cursor,'value',{configurable:true,writable:false,value:0});
 t.equal(raw(read,[12]).status,0,'read-only scalar cell refuses a native write');
 Object.defineProperty(cursor,'value',{configurable:true,writable:true,value:0});
 reset(array([1,2]));const coldRun=start(cold,[2]);t.equal(coldRun.frame.pc,0,'cold dependency refuses the whole body before its prefix');
 t.equal(fields.get('prefixes:I'),0,'cold guard runs no prefix side effect');t.equal(await finish(coldRun),6,'cold continuation initializes at its original read');
 t.equal(j.classes.ColdStateData.staticFields.get('observed:I'),1,'initializer observes the original completed prefix');
 reset(array([1,2,3,4]));t.ok(captured.meta.structuredResumeEntry,'stateful native body retains a proved resume header');
 const frame=new Frame(captured.method),carrier=new Frame(captured.method);frame.className='StaticStateReader';frame.locals[0]=4;
 const thread={id:0,status:'runnable',callStack:new Stack(),pendingException:null};thread.callStack.push(carrier);thread.callStack.push(frame);j.threads=[thread];j.currentThreadIndex=0;
 w.freezeCompilation();j.jit._syncCompileEnvironment={trace:false,assert:true};j.jit.markMainStarted();
 const originalRun=captured.run,execute=w.execute.bind(w),transitions=[];
 captured.run=(...args)=>{args[args.length-1]=2;return originalRun(...args);};
 w.execute=(f,th,state,...rest)=>{if(state===captured)transitions.push({pc:f.pc,osr:!!rest[2]});return execute(f,th,state,...rest);};
 try{let ticks=0;while(thread.callStack.size()>1){await j.executeTick();if(++ticks>100)throw Error('static-state resume did not progress');if(ticks===1)fields.set('data:[B',array([100,100,100,100]));}}
 finally{captured.run=originalRun;w.execute=execute;}
 t.equal(carrier.stack.pop(),10,'resumption uses the captured original array after global replacement');
 t.equal(fields.get('prefixes:I'),1,'native resumption never replays the prefix');t.equal(fields.get('steps:I'),4,'native resumption performs each loop effect once');
 t.ok(transitions.length>1&&transitions.every(r=>!r.osr),'fuel exits return to the same native body');
 t.equal(j.jit.syncCompileCensus().postMainSyncCompileCount,0,'resumption compiles no guest code');
 t.equal(captured.meta.box.frame,null,'finished native entry releases its frame');
 const resumeFallback=async mutate=>{
  reset(array([1,2,3,4]));const paused=raw(captured,[4],2);paused.frame.pc=paused.status;
  t.equal(paused.status,captured.meta.structuredResumeEntry.item,'fuel stops at the proved header before customization');
  mutate();const th={id:0,status:'runnable',callStack:new Stack(),pendingException:null};th.callStack.push(paused.frame);j.threads=[th];j.currentThreadIndex=0;
  const out=w.execute(paused.frame,th,captured,captured.meta.structuredResumeEntry.block);
  t.notOk(out.returned,'revoked entry falls back from the resumed header');
  t.equal(paused.frame.pc,captured.meta.structuredResumeEntry.item,'revocation never restarts the prefix');
  t.equal(await finish({thread:th,out}),10,'resumed fallback retains the captured original array');
  t.equal(fields.get('prefixes:I'),1,'refused resume preserves the single prefix');
  t.equal(fields.get('steps:I'),4,'refused resume preserves every completed iteration');
 };
 await resumeFallback(()=>fields.set('data:[B',Object.assign([100,100,100,100],{type:'[B'})));
 const stepCell=fields.cell('steps:I');let stepValue=0,stepGetters=0;
 await resumeFallback(()=>{stepValue=fields.get('steps:I');Object.defineProperty(stepCell,'value',{configurable:true,get(){stepGetters++;return stepValue;},set(value){stepValue=value;}});});
 t.ok(stepGetters>0,'resumed Java fallback observes the customized scalar cell');
 Object.defineProperty(stepCell,'value',{configurable:true,writable:true,value:0});
 t.end();
});

test('checked static-state callees compose with object-array traversal',async t=>{
 const {newFields,makeObjectRef,writeField,readField}=require('../src/core/objectModel');
 const classpath=compile(t,'CursorReader',`
 public class CursorReader {
  static byte[] data;static int byteCursor,bitCursor;
  static int bit(){int value=data[byteCursor]>>bitCursor&1;bitCursor++;byteCursor+=bitCursor>>3;bitCursor&=7;return value;}
  static int caught(CursorTree tree){try{return tree.decode();}catch(ArrayIndexOutOfBoundsException e){return -71;}catch(NullPointerException e){return -72;}}
 }
 final class CursorTree {
  int[] nodes;int prefixes;
  final int decode(){prefixes++;int at=0;while(nodes[at]>=0)at=CursorReader.bit()!=0?nodes[at]:at+1;return ~nodes[at];}
 }`);
 const j=new JVM({classpath,wasmHeap:true,wasmFields:true,prepareBeforeMain:false,
  jit:{enabled:false,compileWorker:false,retainCompilerDiagnostics:false,wasmStructured:true,
   wasm:{deepInline:false,maxInlineCalleeItems:1,noOnDemandCalleeCompile:true,
    canonicalDirectCalls:true,canonicalEhLinks:true,nativeJsExceptionTags:true}}});
 await j.preloadClasspathClasses();for(const name of ['CursorReader','CursorTree'])j._markClassInitialized(name);
 const w=j.jit.wasmJit;w.importStatsEnabled=true;
 const build=(owner,name,descriptor)=>{const method=j.findMethod(j.classes[owner],name,descriptor),state=w.methodState({method});
  w.compile({method,className:owner},state,{asCallee:true});t.equal(state.status,'ready',state.lastCompileError||name+' compiles');return state;};
 const bit=build('CursorReader','bit','()I'),decode=build('CursorTree','decode','()I'),caught=build('CursorReader','caught','(LCursorTree;)I');
 t.equal(bit.meta.closedNativeBody?.version,1,'static-state proof publishes a closed contract');
 t.deepEqual(bit.meta.closedNativeBody?.objectParameters,[],'contract has no object input');
 t.equal(bit.meta.closedNativeBody?.run,bit.meta.canonicalClosedStorageRun,'contract binds the exact guarded export');
 t.equal(decode.meta.nativeClosedCallSiteCount,1,'object loop reserves a native edge to the static-state reader');
 t.equal(decode.meta.closedNativeBody?.version,1,'composed object loop remains callback-free on success');
 const array=(type,values)=>{const a=j.wasmHeap.alloc(type,values.length);a.type=type;a.set(values);return a;};
 const tree=nodes=>{const o=makeObjectRef(j,'CursorTree',newFields(j,'CursorTree'));writeField(o.fields,'CursorTree.nodes',array('[I',nodes));return o;};
 const fields=j.classes.CursorReader.staticFields;
 const reset=value=>{fields.set('data:[B',value);fields.set('byteCursor:I',0);fields.set('bitCursor:I',0);};
 const raw=(state,args)=>{const f=new Frame(state.method);f.className=state.className;state.meta.paramSlots.forEach((p,i)=>f.locals[p.slot]=args[i]);state.meta.box.frame=f;
  try{const status=state.run(...args,0,1e8);return {status,value:status===-1?takeWasmReturnValue(state.meta):undefined};}finally{state.meta.box.frame=null;}};
 const start=(state,args)=>{const frame=new Frame(state.method);frame.className=state.key.split('.')[0];state.meta.paramSlots.forEach((p,i)=>frame.locals[p.slot]=args[i]);
  const thread={id:0,status:'runnable',callStack:new Stack()};thread.callStack.push(frame);j.threads=[thread];j.currentThreadIndex=0;
  return {frame,thread,out:w.execute(frame,thread,state,0)};};
 const finish=async({thread,out})=>{if(thread.callStack.isEmpty())return out.value;let result,steps=0;
  while(!thread.callStack.isEmpty()&&++steps<50000){const f=thread.callStack.peek(),ins=f.instructions[f.pc++].instruction;
   if(/^[ilfda]return$/.test(getOp(ins)))result=f.stack.peek();
   if(ins)try{await j.executeInstruction(ins,f,thread);}catch(e){j.handleException(e,f.pc-1,thread);}}
  t.ok(thread.callStack.isEmpty(),'exact Java continuation completes');return result;};
 reset(array('[B',[2]));const first=tree([2,-3,-4]);
 t.equal(raw(decode,[first]).value,2,'zero bit follows the increment edge');
 t.equal(raw(decode,[first]).value,3,'one bit follows the tree edge');
 t.equal(readField(first.fields,'CursorTree.prefixes'),2,'each traversal prefix occurs once');
 t.equal(decode.meta.importStats.get('native_body_object_storage'),2,'receiver validation is retained across each child call');
 t.equal(fields.get('bitCursor:I'),2,'child stores remain visible');
 reset(array('[B',[]));const short=tree([2,-3,-4]);
 t.equal(await finish(start(caught,[short])),-71,'child native bounds failure reaches the original outer handler');
 t.equal(readField(short.fields,'CursorTree.prefixes'),1,'bounds failure does not replay the parent prefix');
 t.equal(fields.get('bitCursor:I'),0,'failed byte read performs no later cursor stores');
 reset(null);const terminal=tree([-8]);t.equal(raw(decode,[terminal]).value,7,'unused null static array is not eagerly dereferenced by the parent');
 reset(array('[B',[1]));const cell=fields.cell('bitCursor:I');let value=0,getters=0;
 Object.defineProperty(cell,'value',{configurable:true,get(){getters++;return value;},set(x){value=x;}});
 const custom=tree([2,-3,-4]),paused=start(decode,[custom]);
 t.equal(getters,0,'static guard refusal invokes no getter while parent facts are live');
 t.equal(readField(custom.fields,'CursorTree.prefixes'),1,'refusal preserves the completed parent prefix');
 t.equal(await finish(paused),3,'exact child fallback invokes the original accessor');t.ok(getters>0,'accessor runs only in the supported continuation');
 t.equal(readField(custom.fields,'CursorTree.prefixes'),1,'fallback never repeats the prefix');
 Object.defineProperty(cell,'value',{configurable:true,writable:true,value:0});
 reset(array('[B',[1]));const original=bit.meta;let callbacks=0;
 const {T,OP,assembleModule}=require('../src/jit/wasmShared');
 const unsafe=new WebAssembly.Instance(new WebAssembly.Module(assembleModule({
  importDecls:[{name:'unsafe',params:[],results:[T.i32]}],mainParams:[],mainResults:[T.i32,T.i32],declared:[],
  body:[OP.i32_const,0x7f,OP.call,0,OP.end]})),{env:{unsafe:()=>{callbacks++;return 1;}}}).exports.run;
 bit.meta={...original,closedNativeBody:null,canonicalClosedStorageRun:null,canonicalCompactRun:unsafe};w.canonicalDirectLinks.publish(bit);
 const replaced=tree([2,-3,-4]),retry=start(decode,[replaced]);
 t.equal(callbacks,0,'restricted edge never calls an incompatible replacement');
 t.equal(readField(replaced.fields,'CursorTree.prefixes'),1,'replacement refusal preserves the prefix');
 t.equal(await finish(retry),3,'replacement refusal resumes the original invoke exactly once');
 t.equal(callbacks,0,'Java continuation does not execute the unproved native export');
 bit.meta=original;w.canonicalDirectLinks.publish(bit);
 reset(array('[B',[0]));t.equal(raw(decode,[tree([2,-3,-4])]).value,2,'restored proved target works without recompiling the parent');
 t.end();
});

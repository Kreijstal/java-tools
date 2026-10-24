'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm'),Frame=require('../src/core/frame'),Stack=require('../src/core/callStack');
const {newFields,makeObjectRef,readField,writeField}=require('../src/core/objectModel');
const {allocMultiArray}=require('../src/instructions/object');
const {takeWasmReturnValue}=require('../src/jit/wasmShared');
const compile=require('./javaFixture').makeJavaFixtureCompiler('nested-inline-');

test('nested recovered scopes keep distinct locals, prefixes, reference identity and real child frames',async t=>{
 const classpath=compile(t,'NestedInlineProbe',`
 final class NestedInlineWalker {
  int rowStarts,rowEnds,walkStarts,walkEnds,steps;int[] input;int[][] rows;NestedInlineWalker delegate;
  int choose(int n){walkStarts++;int i=0;while(i<n){steps++;input[0]++;i+=(i&1)+1;}walkEnds++;return 1;}
  int chooseCalled(int n){walkStarts++;int i=0,total=0;while(i<n){steps++;input[0]++;
   total+=NestedInlineProbe.extra(i+3);i+=(i&1)+1;}walkEnds++;return 1+(total&0);}
  int[] row(int n){rowStarts++;int[] value=rows[choose(n)];rowEnds++;return value;}
  int[] rowCalled(int n){rowStarts++;int[] value=rows[chooseCalled(n)];rowEnds++;return value;}
  int[] delegatedRow(int n){rowStarts++;int[] value=rows[delegate.choose(n)];rowEnds++;return value;}
 }
 public class NestedInlineProbe {
  static int starts,ends,caught,calls,marker;
  static long root(NestedInlineWalker w,int n,long seed){starts++;long result=seed+w.row(n)[0];ends++;return result;}
  static long called(NestedInlineWalker w,int n,long seed){starts++;long result=seed+w.rowCalled(n)[0];ends++;return result;}
  static long bounds(NestedInlineWalker w,int n,long seed){starts++;try{long result=seed+w.row(n)[0];ends++;return result;}
   catch(ArrayIndexOutOfBoundsException e){caught++;return w.walkStarts*100+w.steps;}}
  static int nullInner(NestedInlineWalker w){starts++;try{return w.delegatedRow(1)[0];}
   catch(NullPointerException e){caught++;return w.rowStarts*100+starts;}}
  static int extra(int n){int i=0,sum=0;while(i<n){calls++;sum+=i;i+=(i&1)+1;}return sum;}
  static long repeated(NestedInlineWalker w){long sum=0;for(int i=0;i<2;i++)sum+=w.row(1)[0];return sum;}
  static long staticReads(NestedInlineWalker w){long sum=0;for(int i=0;i<2;i++)sum+=marker+w.row(0)[0];return sum;}
 }`);
 const j=new JVM({classpath,wasmHeap:true,wasmFields:true,prepareBeforeMain:false,
  jit:{enabled:false,compileWorker:false,retainCompilerDiagnostics:false,wasmStructured:true,
   wasm:{deepInline:false,canonicalDirectCalls:true,canonicalEhLinks:true,nativeJsExceptionTags:true}}});
 await j.preloadClasspathClasses();for(const name of ['NestedInlineWalker','NestedInlineProbe'])j._markClassInitialized(name);
 const w=j.jit.wasmJit;w.enabled=true;
 const build=(name,descriptor)=>{const method=j.findMethod(j.classes.NestedInlineProbe,name,descriptor),state=w.methodState({method});
  w.compile({method,className:'NestedInlineProbe'},state,{asCallee:true});
  t.equal(state.status,'ready',state.lastCompileError||name+' compiles');return state;};
 const extra=build('extra','(I)I'),root=build('root','(LNestedInlineWalker;IJ)J'),called=build('called','(LNestedInlineWalker;IJ)J'),
  bounds=build('bounds','(LNestedInlineWalker;IJ)J'),nullInner=build('nullInner','(LNestedInlineWalker;)I');
 const repeated=build('repeated','(LNestedInlineWalker;)J'),staticReads=build('staticReads','(LNestedInlineWalker;)J');
 for(const state of [root,called,bounds,nullInner,repeated,staticReads]){
  t.equal(state.meta.inlineActivationDepth,2,state.method.name+' reconstructs two real inlined scopes');
  t.ok(state.meta.normalFlowFullyCompiled,state.method.name+' keeps full normal flow');
  t.equal(state.meta.speculations,0,state.method.name+' has checked fixed dispatch');
 }
 const fields=j.classes.NestedInlineProbe.staticFields;
 const array=xs=>{const a=j.wasmHeap.alloc('[I',xs.length);a.type='[I';a.set(xs);return a;};
 const rows=value=>{const a=allocMultiArray(j,'[[I',[2,1]);a[0][0]=3;a[1][0]=value;return a;};
 const owner=(input=[0])=>{const book=makeObjectRef(j,'NestedInlineWalker',newFields(j,'NestedInlineWalker'));
  writeField(book.fields,'NestedInlineWalker.input',array(input));writeField(book.fields,'NestedInlineWalker.rows',rows(7));return book;};
 const field=(book,name)=>readField(book.fields,'NestedInlineWalker.'+name);
 const reset=()=>{for(const key of ['starts','ends','caught','calls'])fields.set(key+':I',0);};
 const frameFor=(state,args)=>{const frame=new Frame(state.method);frame.className='NestedInlineProbe';
  state.meta.paramSlots.forEach((p,i)=>frame.locals[p.slot]=args[i]);return frame;};
 const raw=(state,args,fuel=100000000)=>{const frame=frameFor(state,args);state.meta.box.frame=frame;
  try{const status=state.run(...args,0,fuel);return {status,value:status===-1?takeWasmReturnValue(state.meta):undefined};}
  finally{state.meta.box.frame=null;}};
 const retired=[];
 const start=(state,args,fuel=100000000)=>{
  const frame=frameFor(state,args),carrier=new Frame(state.method),thread={id:0,status:'runnable',callStack:new Stack()};
  thread.callStack.push(carrier);thread.callStack.push(frame);j.threads=[thread];j.currentThreadIndex=0;
  const run=state.run;state.run=(...values)=>{values[values.length-1]=fuel;return run(...values);};
  try{w.execute(frame,thread,state,0);}finally{state.run=run;}
  return {frame,carrier,thread};
 };
 const finish=async run=>{
  const {thread,carrier}=run;
  for(let ticks=0;thread.callStack.size()>1&&ticks<20000;ticks++){
   const frame=thread.callStack.peek(),at=frame.pc++,ins=frame.instructions[at].instruction;
   if(ins)try{await j.executeInstruction(ins,frame,thread);}catch(error){
    const label=frame.instructions[at].labelDef;j.handleException(error,label?parseInt(label.slice(1,-1),10):at,thread);
   }
  }
  t.equal(thread.callStack.size(),1,'original frames and continuations all retire');return carrier.stack.pop();
 };
 w.freezeCompilation();j.jit._syncCompileEnvironment={trace:false,assert:true};j.jit.markMainStarted();
 const seed=0x7123456789abcdefn;
 for(const n of [0,1,7]){
  reset();const book=owner();let steps=0;for(let i=0;i<n;i+=(i&1)+1)steps++;
  const result=raw(root,[book,n,seed]);t.equal(result.status,-1,'nested normal execution returns n='+n);
  t.equal(result.value,BigInt.asIntN(64,seed+7n),'nested normal result preserves its wide prefix');
  t.deepEqual(['rowStarts','rowEnds','walkStarts','walkEnds','steps'].map(k=>field(book,k)),[1,1,1,1,steps],
   'normal path commits each original scope exactly once');
  t.equal(root.meta.box.pendingFrames,null,'normal path materializes no interpreter frames');
 }
 reset();const unused=owner();writeField(unused.fields,'NestedInlineWalker.input',null);
 t.equal(raw(root,[unused,0,seed]).value,BigInt.asIntN(64,seed+7n),'unused null inner input stays legal');
 reset();const book=owner(),oldRows=field(book,'rows'),run=start(root,[book,7,seed],2);
 t.equal(run.thread.callStack.size(),4,'fuel reconstructs both scopes above the original root and carrier');
 let inner=run.thread.callStack.peek();retired.push(new WeakRef(inner));
 t.equal(inner.method.name,'choose','deepest frame names the real traversal');
 run.thread.callStack.pop();let middle=run.thread.callStack.peek();run.thread.callStack.push(inner);retired.push(new WeakRef(middle));
 t.equal(middle.method.name,'row','middle frame names the original wrapper');
 t.equal(run.frame.stack.peek(),seed,'wide root prefix stays on the original caller');
 t.equal(middle.stack.peek(),oldRows,'captured reference prefix stays on its own wrapper');
 t.ok(w.canonicalResumeFrames.has(run.frame)&&w.canonicalResumeFrames.has(middle)&&w.canonicalResumeFrames.has(inner),
  'every reconstructed scope retains canonical recovery ownership');
 inner=null;middle=null;
 writeField(book.fields,'NestedInlineWalker.rows',rows(100));oldRows[1][0]=11;
 t.equal(await finish(run),BigInt.asIntN(64,seed+11n),'resumed wrapper uses its captured original reference');
 t.deepEqual(['rowStarts','rowEnds','walkStarts','walkEnds','steps'].map(k=>field(book,k)),[1,1,1,1,4],
  'resumption neither replays prefixes nor drops loop effects');
 t.equal(field(book,'input')[0],4,'each inner array update happens once');
 t.equal(fields.get('starts:I'),1,'root prefix executes once');t.equal(fields.get('ends:I'),1,'root tail executes once');
 reset();extra.meta.canonicalFuel.value=2;const calledBook=owner(),deep=start(called,[calledBook,7,seed]);
 t.equal(deep.thread.callStack.size(),5,'real yielding helper remains above both reconstructed scopes');
 t.equal(deep.thread.callStack.peek().method.name,'extra','real child retains its method and native handoff');
 t.equal(await finish(deep),BigInt.asIntN(64,seed+7n),'real child return resumes the correct nested operand prefixes');
 t.equal(fields.get('calls:I'),14,'every real helper effect executes exactly once');
 t.ok(extra.meta.directFrameContext.directExitCount>0,'real helper uses nonzero native invocation ownership');
 reset();const nullBook=owner();writeField(nullBook.fields,'NestedInlineWalker.delegate',null);
 t.equal(await finish(start(nullInner,[nullBook])),101,'inner guard miss preserves the completed wrapper prefix and root handler');
 t.equal(field(nullBook,'rowStarts'),1,'inner guard miss never replays its wrapper');
 t.equal(field(nullBook,'walkStarts'),0,'null inner receiver starts no traversal');
 t.equal(fields.get('caught:I'),1,'inner failure reaches its original outer handler once');
 reset();const faulty=owner([]);
 t.equal(await finish(start(bounds,[faulty,7,seed])),101n,'native bounds failure before a yield reaches the root handler');
 t.equal(field(faulty,'walkStarts'),1,'pre-yield failure preserves the traversal prefix');
 reset();const later=owner(),faultAfter=start(bounds,[later,7,seed],2);
 writeField(later.fields,'NestedInlineWalker.input',array([]));
 t.equal(await finish(faultAfter),102n,'failure after nested resumption reaches the original root handler');
 t.equal(field(later,'rowStarts'),1,'post-yield exception does not replay its wrapper prefix');
 reset();const customized=owner(),savedRows=field(customized,'rows');let fieldGets=0;
 Object.defineProperty(customized.fields,'NestedInlineWalker.rows',{configurable:true,get(){fieldGets++;return savedRows;}});
 t.equal(await finish(start(root,[customized,1,seed])),BigInt.asIntN(64,seed+7n),
  'customized nested reference field retains the original Java result');
 t.equal(fieldGets,1,'inlining does not bypass the original customized field getter');
 t.equal(field(customized,'rowStarts'),1,'custom field continuation does not replay its wrapper prefix');
 reset();const foreignOwner=owner(),foreign=[array([3]),array([13])];foreign.type='[[I';let elementGets=0;
 Object.defineProperty(foreign,1,{configurable:true,get(){elementGets++;return array([13]);}});
 writeField(foreignOwner.fields,'NestedInlineWalker.rows',foreign);
 t.equal(await finish(start(root,[foreignOwner,1,seed])),BigInt.asIntN(64,seed+13n),
  'nested foreign reference-array fallback retains the original returned reference');
 t.equal(elementGets,1,'nested foreign reference getter runs exactly once');
 reset();const primitiveOwner=owner(),foreignInput=[0];foreignInput.type='[I';let inputValue=0,primitiveGets=0;
 Object.defineProperty(foreignInput,0,{configurable:true,get(){
  if(primitiveGets++===0)writeField(primitiveOwner.fields,'NestedInlineWalker.rows',rows(100));return inputValue;
 },set(value){inputValue=value;}});
 writeField(primitiveOwner.fields,'NestedInlineWalker.input',foreignInput);
 const primitiveResult=raw(repeated,[primitiveOwner]);
 t.equal(primitiveResult.status,-1,'foreign primitive callback can complete through the compiled loop');
 t.equal(primitiveResult.value,107n,'primitive callback invalidates future field values without replacing a captured row');
 t.equal(primitiveGets,2,'each original primitive getter executes once');
 reset();const staticOwner=owner(),cell=fields.cell('marker:I');let staticGets=0;
 Object.defineProperty(cell,'value',{configurable:true,get(){
  if(++staticGets===2)writeField(staticOwner.fields,'NestedInlineWalker.rows',rows(100));return staticGets;
 }});
 t.equal(raw(staticReads,[staticOwner]).value,110n,'uncertified static reads retain their original callbacks and field effects');
 t.equal(staticGets,2,'customized static cell is read at each original Java instruction');
 Object.defineProperty(cell,'value',{configurable:true,writable:true,value:0});
 if(global.gc){for(let i=0;i<8;i++){await new Promise(setImmediate);global.gc();}
  t.ok(retired.every(weak=>!weak.deref()),'live compiled modules retain no retired nested child frames');}
 t.equal(root.meta.inlineActivations,undefined,'installed module retains no nested analysis map');
 t.equal(j.jit.syncCompileCensus().postMainSyncCompileCount,0,'normal/fuel/callback/exception paths compile no Java methods');t.end();
});

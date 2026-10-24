'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm'),Frame=require('../src/core/frame'),Stack=require('../src/core/callStack');
const {newFields,makeObjectRef,readField,writeField}=require('../src/core/objectModel');
const {takeWasmReturnValue}=require('../src/jit/wasmShared');
const compile=require('./javaFixture').makeJavaFixtureCompiler('inline-activation-');
const source=`final class InlineWalker {
 int prefixes,steps,tails;int[] data;
 final int scan(int[] a,int n){prefixes++;int i=0,sum=3;while(i<n){steps++;a[i]++;
  sum=sum*31+a[i];i+=(a[i]&1)+1;}tails++;return sum;}
 final long wide(int n,long seed){prefixes++;int i=0;long sum=seed;
  while(i<n){steps++;sum=sum*3+i;i+=(i&1)+1;}tails++;return sum;}
 final int pick(int n){prefixes++;int i=0;while(i<n){steps++;data[1]++;i+=(i&1)+1;}tails++;return 1;}
 final int chained(int n){prefixes++;int i=0,total=3;while(i<n){steps++;
  total+=InlineActivationProbe.tiny(i+4);i+=(i&1)+1;}tails++;return total;}
 final int follow(int[] next){prefixes++;int node=0;while(node>=0){steps++;node=next[node];}tails++;return steps;}
int root(int[] a,int n){InlineActivationProbe.starts++;int sum=7+scan(a,n);InlineActivationProbe.ends++;return sum;}
 long rootWide(int n,long seed){InlineActivationProbe.starts++;long sum=seed+wide(n,seed);InlineActivationProbe.ends++;return sum;}
 int capture(int n){InlineActivationProbe.starts++;int sum=data[pick(n)];InlineActivationProbe.ends++;return sum;}
 int chainRoot(int n){InlineActivationProbe.starts++;int sum=7+chained(n);InlineActivationProbe.ends++;return sum;}
 int followRoot(int[] next){InlineActivationProbe.starts++;int sum=7+follow(next);InlineActivationProbe.ends++;return sum;}
 int caught(int[] a,int n){InlineActivationProbe.starts++;try{int result=7+scan(a,n);InlineActivationProbe.ends++;return result;}
  catch(ArrayIndexOutOfBoundsException e){InlineActivationProbe.ends++;return prefixes*1000+steps*10+tails;}}
}
public class InlineActivationProbe {static int starts,ends,calls;
 static int tiny(int n){int j=0,sum=0;while(j<n){calls++;sum+=j;j+=(j&1)+1;}return sum;}
 static int relay(InlineWalker w,int n){return 11+w.chainRoot(n);}
 static int guarded(InlineWalker w,int[] a,int n){starts++;int sum=0;for(int i=0;i<3;i++)sum+=w.scan(a,n);ends++;return sum;}
 static int caughtGuarded(InlineWalker w,int[] a,int n){try{return guarded(w,a,n);}catch(NullPointerException e){return -91;}}
 static long guardedWide(InlineWalker w,int n,long seed){starts++;long sum=seed+w.wide(n,seed);ends++;return sum;}
 static long caughtGuardedWide(InlineWalker w,int n,long seed){try{return guardedWide(w,n,seed);}catch(NullPointerException e){return -91L;}}
}`;

test('flattened non-counted loops recover real inner frames without replaying stores',async t=>{
 const classpath=compile(t,'InlineActivationProbe',source),j=new JVM({classpath,wasmHeap:true,wasmFields:true,
  jit:{enabled:false,compileWorker:false,retainCompilerDiagnostics:false,wasmStructured:true,
   wasm:{deepInline:false,canonicalDirectCalls:true,canonicalEhLinks:true,nativeJsExceptionTags:true}}});
 await j.preloadClasspathClasses();for(const name of ['InlineWalker','InlineActivationProbe'])j._markClassInitialized(name);
 const w=j.jit.wasmJit;w.enabled=true;
 const build=(name,descriptor,owner='InlineWalker',sites=1,asCallee=true)=>{const method=j.findMethod(j.classes[owner],name,descriptor),st=w.methodState({method});
  w.compile({method,className:owner},st,{asCallee});
  t.equal(st.status,'ready',st.lastCompileError||name+' compiles');
  t.ok(st.meta?.structured,name+' uses structured Wasm');
  t.equal(st.meta?.inlineActivationSiteCount,sites,name+' has the expected resumable inline activations');return st;};
 const root=build('root','([II)I'),wide=build('rootWide','(IJ)J'),capture=build('capture','(I)I');
 const tiny=build('tiny','(I)I','InlineActivationProbe',0),chain=build('chainRoot','(I)I'),
  relay=build('relay','(LInlineWalker;I)I','InlineActivationProbe',1),caught=build('caught','([II)I'),
  follow=build('followRoot','([I)I');
 const guarded=build('guarded','(LInlineWalker;[II)I','InlineActivationProbe',1,false);
 const caughtGuarded=build('caughtGuarded','(LInlineWalker;[II)I','InlineActivationProbe',0);
 const guardedWide=build('guardedWide','(LInlineWalker;IJ)J','InlineActivationProbe',1);
 const caughtGuardedWide=build('caughtGuardedWide','(LInlineWalker;IJ)J','InlineActivationProbe',0);
 t.ok(guarded.meta.normalFlowFullyCompiled,'nullable receiver loop keeps complete normal-flow coverage without a forced callee preference');
 const array=xs=>{const a=j.wasmHeap.alloc('[I',xs.length);a.type='[I';a.set(xs);return a;};
 const walker=()=>makeObjectRef(j,'InlineWalker',newFields(j,'InlineWalker'));
 const field=(o,k)=>readField(o.fields,'InlineWalker.'+k);
 const fields=j.classes.InlineActivationProbe.staticFields;
 const reset=()=>{fields.set('starts:I',0);fields.set('ends:I',0);};
 const oracle=(a,n)=>{let i=0,sum=3,steps=0;while(i<n){steps++;a[i]++;sum=(Math.imul(sum,31)+a[i])|0;i+=(a[i]&1)+1;}return {sum:sum+7|0,steps};};
 const invoke=(st,args,fuel)=>{reset();const frame=new Frame(st.method);frame.className=st.key.split('.')[0];
  st.meta.box.frame=frame;try{return {status:st.run(...args,0,fuel),frame};}finally{st.meta.box.frame=null;}};
 const retired=[];
 const finish=async(st,args,afterYield,{fuel=2,depth=3}={})=>{
  reset();const frame=new Frame(st.method);frame.className=st.key.split('.')[0];
  let slot=0;for(const [i,value]of args.entries()){frame.locals[slot]=value;slot+=st.meta.paramSlots[i].t===0x7e||st.meta.paramSlots[i].t===0x7c?2:1;}
  const carrier=new Frame(st.method),thread={id:0,status:'runnable',callStack:new Stack()};
  thread.callStack.push(carrier);thread.callStack.push(frame);j.threads=[thread];j.currentThreadIndex=0;
  const raw=st.run;st.run=(...values)=>{values[values.length-1]=fuel;return raw(...values);};
  try{w.execute(frame,thread,st,0);}finally{st.run=raw;}
  t.equal(thread.callStack.size(),depth,'yield materializes the exact inner chain above the existing caller');
  const child=thread.callStack.peek();
  retired.push(new WeakRef(child));
  t.equal(child.className,depth===3?'InlineWalker':'InlineActivationProbe','materialized frame names the real class');
  t.equal(frame.pc,st.method.attributes.find(a=>a.type==='code').code.codeItems.findIndex(
   x=>x.instruction?.op==='invokevirtual')+1,'caller resumes after the original invocation');
  t.ok(child.pc>0,'child resumes at an interior bytecode PC');
  t.ok(w.canonicalResumeFrames.has(frame)&&w.canonicalResumeFrames.has(child),'both frames keep canonical recovery ownership');
  if(afterYield)afterYield({frame,child});
  let steps=0;
  while(thread.callStack.size()>1&&++steps<10000){
   const f=thread.callStack.peek(),at=f.pc++,ins=f.instructions[at].instruction;
   if(ins)try{await j.executeInstruction(ins,f,thread);}catch(e){
    const label=f.instructions[at].labelDef; j.handleException(e,label?parseInt(label.slice(1,-1)):at,thread);
   }
  }
  t.equal(thread.callStack.size(),1,'recovered invocation and caller retire');
  t.equal(fields.get('starts:I'),1,'caller prefix ran once');t.equal(fields.get('ends:I'),1,'caller tail ran once');
  return carrier.stack.pop();
 };
 w.freezeCompilation();
 for(const n of [0,1,12]){
  const xs=Array.from({length:20},(_,i)=>i*3),expected=oracle(Int32Array.from(xs),n),a=array(xs),o=walker();
  const r=invoke(root,[o,a,n],1000000);
  t.equal(r.status,-1,'normal flattened loop returns n='+n);t.equal(takeWasmReturnValue(root.meta),expected.sum,'normal result exact');
  t.equal(field(o,'prefixes'),1,'normal callee prefix once');t.equal(field(o,'steps'),expected.steps,'normal loop stores exact');
  t.equal(root.meta.box.pendingFrames,null,'normal return allocates no pending child');
 }
 const xs=Array.from({length:20},(_,i)=>i*3),out=Int32Array.from(xs),expected=oracle(out,12),a=array(xs),o=walker();
 t.equal(await finish(root,[o,a,12]),expected.sum,'resumed result exact');t.deepEqual([...a],[...out],'every array store occurs once');
 t.equal(field(o,'prefixes'),1,'callee prefix does not replay');t.equal(field(o,'tails'),1,'callee tail once');
 t.equal(field(o,'steps'),expected.steps,'every loop side effect occurs once');
 const guardedInput=Int32Array.from(xs);let guardedExpected=0,guardedSteps=0;
 for(let i=0;i<3;i++){const value=oracle(guardedInput,12);guardedExpected=(guardedExpected+value.sum-7)|0;guardedSteps+=value.steps;}
 const guardedOwner=walker(),guardedArray=array(xs),guardedRun=invoke(guarded,[guardedOwner,guardedArray,12],1000000);
 t.equal(guardedRun.status,-1,'guarded loop completes through normal compiled flow');
 t.equal(takeWasmReturnValue(guarded.meta),guardedExpected,'guarded loop result matches all three original calls');
 t.deepEqual([...guardedArray],[...guardedInput],'guarded fast path preserves every Java array store');
 t.equal(field(guardedOwner,'steps'),guardedSteps,'guarded fast path preserves loop state');
 t.equal(guarded.meta.box.pendingFrames,null,'guarded normal return allocates no child frames');
 t.equal(fields.get('starts:I'),1,'guarded caller prefix occurs once');t.equal(fields.get('ends:I'),1,'guarded caller tail occurs once');
 const guardedResumeOwner=walker(),guardedResumeArray=array(xs);
 t.equal(await finish(guarded,[guardedResumeOwner,guardedResumeArray,12],null,{fuel:3}),guardedExpected,
  'guarded inlined loop recovers its original activation on a fuel exit');
 t.deepEqual([...guardedResumeArray],[...guardedInput],'guarded resumption does not replay any original call');
 t.equal(field(guardedResumeOwner,'prefixes'),3,'each original guarded invocation starts once');
 const nullMiss=async(st,args)=>{
  reset();const frame=new Frame(st.method),carrier=new Frame(st.method);frame.className='InlineActivationProbe';
  st.meta.paramSlots.forEach((p,i)=>frame.locals[p.slot]=args[i]);
  const thread={id:0,status:'runnable',callStack:new Stack()};thread.callStack.push(carrier);thread.callStack.push(frame);
  j.threads=[thread];j.currentThreadIndex=0;w.execute(frame,thread,st,0);
  for(let ticks=0;thread.callStack.size()>1&&ticks<1000;ticks++){
   const f=thread.callStack.peek(),at=f.pc++,ins=f.instructions[at].instruction;
   if(ins)try{await j.executeInstruction(ins,f,thread);}catch(e){j.handleException(e,at,thread);}
  }
  t.equal(thread.callStack.size(),1,'null guard miss reaches the original handler and retires');
  return carrier.stack.pop();
 };
 t.equal(await nullMiss(caughtGuarded,[null,array(xs),12]),-91,'null guard miss retains original invocation exception semantics');
 t.equal(fields.get('starts:I'),1,'null guard miss does not replay the caller prefix');
 t.equal(fields.get('ends:I'),0,'null guard miss does not run the uncompleted caller tail');
 const seed=0x7123456789abcdefn,ow=walker();let total=seed,count=0;
 for(let i=0;i<13;i+=(i&1)+1){total=BigInt.asIntN(64,total*3n+BigInt(i));count++;}
 t.equal(await finish(wide,[ow,13,seed]),BigInt.asIntN(64,seed+total),'category-2 operand prefix and callee locals survive');
 t.equal(field(ow,'steps'),count,'wide loop effects exact');
 const wideGuardOwner=walker();
 t.equal(await finish(guardedWide,[wideGuardOwner,13,seed]),BigInt.asIntN(64,seed+total),
  'guarded wide arguments and category-2 operand prefix survive a fuel handoff');
 t.equal(field(wideGuardOwner,'steps'),count,'guarded wide loop preserves every effect');
 t.equal(await nullMiss(caughtGuardedWide,[null,13,seed]),-91n,'wide guard miss preserves its original result type and handler');
 t.equal(fields.get('starts:I'),1,'wide guard miss does not replay the original caller');
 const oc=walker(),old=array([0,20]),fresh=array([0,100]);writeField(oc.fields,'InlineWalker.data',old);
 const result=await finish(capture,[oc,9],()=>writeField(oc.fields,'InlineWalker.data',fresh));
 t.equal(result,old[1],'outer operand stack keeps its captured reference across yield');
 t.ok(fresh[1]>100,'resumed inner field reads observe replacement');
 t.equal(field(oc,'prefixes'),1,'captured-reference child prefix once');
 const och=walker();fields.set('calls:I',0);tiny.meta.canonicalFuel.value=2;
 t.equal(await finish(chain,[och,7],({child,frame})=>{
  t.equal(child.method.name,'tiny','deepest canonical child retains its method');
  t.equal(frame.stack.peek(),7,'outer operand prefix is separated from the inner prefix');
 },{fuel:1000000,depth:4}),43,'a yielding call inside the flattened loop resumes without replay');
 t.equal(field(och,'prefixes'),1,'nested-call callee prefix once');
 t.equal(field(och,'tails'),1,'nested-call callee tail once');
 const orelay=walker();fields.set('calls:I',0);tiny.meta.canonicalFuel.value=2;
 t.equal(await finish(relay,[orelay,7],({child})=>{
  t.equal(child.method.name,'tiny','native canonical caller preserves deepest frame');
 },{fuel:1000000,depth:5}),54,'direct native activation donates all flattened and real children');
 t.equal(relay.meta.inlineActivationDepth,2,'relay removes both nested instance boundaries');
 t.ok(tiny.meta.directFrameContext.directExitCount>0,'inline recovery is exercised through a nonzero real helper invocation id');
 const faulty=array([0]),of=walker();
 t.equal(await finish(caught,[of,faulty,10]),1020,'exception after a fuel yield reaches the original outer handler');
 t.deepEqual([...faulty],[1],'preceding store is not replayed on exception');
 t.equal(field(of,'prefixes'),1,'throwing child prefix once');
 const cyclic=array([0]),cycleOwner=walker();
 t.equal(await finish(follow,[cycleOwner,cyclic],()=>{cyclic[0]=-1;}),9,
  'cyclic index traversal yields and observes repair without replay');
 t.equal(field(cycleOwner,'prefixes'),1,'cyclic traversal prefix once');
 // A native fault before any yield must dispatch directly to the outer
 // handler, preserving the preceding partial stores and receiver local.
 reset();const directFault=array([0]),directOwner=walker(),faultFrame=new Frame(caught.method),faultCarrier=new Frame(caught.method);
 faultFrame.className='InlineWalker';faultFrame.locals[0]=directOwner;faultFrame.locals[1]=directFault;faultFrame.locals[2]=10;
 const faultThread={id:0,status:'runnable',callStack:new Stack()};faultThread.callStack.push(faultCarrier);faultThread.callStack.push(faultFrame);
 j.threads=[faultThread];j.currentThreadIndex=0;w.execute(faultFrame,faultThread,caught,0);
 t.equal(faultThread.callStack.size(),2,'native exception enters the outer handler without replaying the child');
 t.equal(faultFrame.stack.peek()?.type,'java/lang/ArrayIndexOutOfBoundsException','handler receives the Java exception');
 for(let ticks=0;faultThread.callStack.size()>1&&ticks<100;ticks++){
  const f=faultThread.callStack.peek(),ins=f.instructions[f.pc++].instruction;if(ins)await j.executeInstruction(ins,f,faultThread);
 }
 t.equal(faultCarrier.stack.pop(),1020,'native exception preserves the exact partial effect state');
 t.deepEqual([...directFault],[1],'native fault never repeats the first store');
 if(global.gc){
  for(let i=0;i<8;i++){await new Promise(setImmediate);global.gc();}
  t.ok(retired.every(r=>!r.deref()),'live compiled modules retain no donated child frames');
 }
 t.equal(root.meta.inlineActivations,undefined,'installed metadata retains no inline analysis map');
 t.end();
});

'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm');
const Frame=require('../src/core/frame');
const Stack=require('../src/core/stack');
const {makeJavaFixtureCompiler}=require('./javaFixture');
const fixture=makeJavaFixtureCompiler('wasm-inline-budget-');

test('Wasm inline limits are explicit, bounded per JVM, and validated',t=>{
  const defaultJit=new JVM({jit:{compileWorker:false}}).jit.wasmJit;
  t.equal(defaultJit.maxInlineCalleeItems,96,'existing callee limit remains default');
  t.equal(defaultJit.inlineBudget,512,'existing expansion budget remains default');
  for(const name of ['maxInlineCalleeItems','inlineBudget']){
    for(const value of [0,-1,1.5,NaN,Infinity,'512',Number.MAX_SAFE_INTEGER+1])
      t.throws(()=>new JVM({jit:{compileWorker:false,wasm:{[name]:value}}}),/positive safe integer/,'rejects '+name+'='+String(value));
    const configured=new JVM({jit:{compileWorker:false,wasm:{[name]:1024}}}).jit.wasmJit;
    t.equal(configured[name],1024,'explicit '+name+' is local to its JVM');
  }
  t.equal(defaultJit.maxInlineCalleeItems,96,'another JVM does not change defaults');
  t.end();
});

test('larger inlined array leaf preserves writes, bounds failures and nulls',async t=>{
  const additions=Array.from({length:24},(_,i)=>`sum += data[(index+${i})&31];`).join('\n');
  const classpath=fixture(t,'InlineBudget',`public final class InlineBudget {
    private int sample(int[] data,int index) { int sum=0; ${additions} data[index&31]++; return sum; }
    public void drive(int[] data,int[] out) { for(int i=0;i<out.length;i++)out[i]=sample(data,i); }
  }`);
  const observations=[];
  for(const config of [{},{maxInlineCalleeItems:512,inlineBudget:1},{maxInlineCalleeItems:512,inlineBudget:1024}]){
    const j=new JVM({classpath,jit:{codegen:false,compileWorker:false,wasmStructured:true,wasm:config}});
    await j.preloadClasspathClasses();j.classInitializationState.set('InlineBudget','INITIALIZED');
    const w=j.jit.wasmJit;w.enabled=true;
    const leaf=await j.findMethodInHierarchy('InlineBudget','sample','([II)I');
    t.ok(j.jit.getCodeItems(leaf).length>96,'fixture exceeds original size limit');
    const method=await j.findMethodInHierarchy('InlineBudget','drive','([I[I)V');
    const state=w.methodState({method});w.compile({method,className:'InlineBudget'},state,{asCallee:true});
    t.equal(state.status,'ready','caller compiles');
    t.equal(state.meta.inlinedCalls,config.inlineBudget===1024?1:0,'both limits constrain actual inlining');
    const rows=[];
    for(const length of [32,12,null]){
      const data=length===null?null:Int32Array.from({length},(_,i)=>i*3-17),out=new Int32Array(4);
      const expected=data&&Array.from(data),wanted=[];
      if(length===32)for(let i=0;i<4;i++){
        let sum=0;for(let k=0;k<24;k++)sum=(sum+expected[(i+k)&31])|0;
        wanted.push(sum);expected[i]++;
      }
      const frame=new Frame(method);frame.className='InlineBudget';
      frame.locals[0]={type:'InlineBudget',fields:{}};frame.locals[1]=data;frame.locals[2]=out;
      const thread={status:'runnable',callStack:new Stack()};thread.callStack.push(frame);
      let result,error;try{result=w.runNested(frame,thread);}catch(e){error=e;}
      if(length===32){t.ok(result?.returned,'normal call completes');t.deepEqual([...out],wanted,'exact sums');t.deepEqual([...data],expected,'each guest write occurs once');}
      else {t.equal(error?.type,length===null?'java/lang/NullPointerException':'java/lang/ArrayIndexOutOfBoundsException','exact guest exception');t.deepEqual([...out],[0,0,0,0],'failed leaf does not publish a result');}
      rows.push({data:data&&[...data],out:[...out],error:error?.type});
    }
    observations.push(rows);
  }
  for(const rows of observations.slice(1))t.deepEqual(rows,observations[0],'inlined and linked execution agree');
  t.end();
});

test('this-receiver proof traces arguments without confusing receivers or joins',async t=>{
  const classpath=fixture(t,'ReceiverProof',`public final class ReceiverProof {
    private int withSelf(ReceiverProof value) { return 7; }
    private int wide(long value,double other) { return (int)value+(int)other; }
    int direct(ReceiverProof value) { return withSelf(value); }
    int wideCaller(long value,double other) { return wide(value,other); }
    int foreign(ReceiverProof value) { return value.withSelf(this); }
    int joined(ReceiverProof value,boolean first) { return (first?this:value).withSelf(this); }
    static int constant() { return 7; }
    static int staticCaller() { return constant(); }
  }`);
  const j=new JVM({classpath,jit:{compileWorker:false}});
  await j.preloadClasspathClasses();j.classInitializationState.set('ReceiverProof','INITIALIZED');
  const {inlineCalls}=require('../src/jit/wasmInline');
  const expand=(code,budget)=>inlineCalls(j,code,{budget,hierarchy:j.jit.wasmJit.hierarchy,
    callerClassName:'ReceiverProof',callerIsStatic:false});
  let foreignCode;
  for(const [name,descriptor,elided] of [
    ['direct','(LReceiverProof;)I',1],['wideCaller','(JD)I',1],
    ['foreign','(LReceiverProof;)I',0],['joined','(LReceiverProof;Z)I',0],
  ]){
    const method=await j.findMethodInHierarchy('ReceiverProof',name,descriptor);
    const code=method.attributes.find(a=>a.type==='code'),result=expand(code);
    t.ok(result?.inlined,name+' is expanded');
    t.equal(result.elidedThisGuards,elided,name+' retains exactly the required receiver guard');
    if(name==='foreign')foreignCode=code;
  }
  const expandedForeign=expand(foreignCode);
  const expansionCost=expandedForeign.items.length-foreignCode.code.codeItems.length+1;
  t.equal(expand(foreignCode,expansionCost)?.inlined,1,'exact expansion budget includes receiver-slot cleanup');
  t.equal(expand(foreignCode,expansionCost-1),null,'one item below the total cost cannot overrun the budget');
  const staticMethod=await j.findMethodInHierarchy('ReceiverProof','staticCaller','()I');
  const staticCode=staticMethod.attributes.find(a=>a.type==='code');
  const staticExpand=budget=>inlineCalls(j,staticCode,{budget,callerIsStatic:true});
  const staticCost=staticExpand().items.length-staticCode.code.codeItems.length+1;
  t.equal(staticExpand(staticCost)?.inlined,1,'exact static budget includes the zero-argument entry marker');
  t.equal(staticExpand(staticCost-1),null,'one item below static expansion cost is refused');
  const call=foreignCode.code.codeItems.find(item=>String(item.instruction?.op).startsWith('invoke')).instruction;
  for(const [name,instructions] of [
    ['stack shuffle',['aload_0','dup',call,'ireturn']],
    ['overwritten this',['aload_1','astore_0','aload_0','aload_1',call,'ireturn']],
  ]){
    const code={type:'code',code:{...foreignCode.code,
      codeItems:instructions.map((instruction,i)=>({labelDef:`P${i}:`,instruction}))}};
    const result=expand(code);
    t.ok(result?.inlined,name+' still supports guarded expansion');
    t.equal(result.elidedThisGuards,0,name+' does not bypass the guard');
  }
  t.end();
});

"use strict";
const test=require('tape');
const {JVM}=require('../src/core/jvm');
const Frame=require('../src/core/frame');
const Stack=require('../src/core/stack');
const instructions=[
 {op:'iinc',varnum:0,incr:-1},'iload_0',{op:'ifle',arg:'Lreturn'},
 'iload_2',{op:'ifne',arg:'Lb'},
 {op:'iinc',varnum:1,incr:1},'iload_1',{op:'bipush',arg:10},{op:'if_icmpge',arg:'Louter'},{op:'goto',arg:'Lb'},
 {op:'iinc',varnum:1,incr:2},'iload_1',{op:'bipush',arg:10},{op:'if_icmpge',arg:'Louter'},{op:'goto',arg:'La'},
 'iload_1','ireturn'];
const labels={0:'Louter:',5:'La:',10:'Lb:',15:'Lreturn:'};
function method(){return {className:'SplitKernel',name:'nested',descriptor:'(III)I',flags:['static'],attributes:[{type:'code',code:{
 codeItems:instructions.map((instruction,i)=>({labelDef:labels[i]||`L${i}:`,instruction})),localsSize:'3',stackSize:'2',exceptionTable:[]}}]};}
function reference(n,acc,mode){for(;;){n--;if(n<=0)return acc;let at=mode!==0;for(;;){acc+=at?2:1;if(acc>=10)break;at=!at;}}}
function harness(enabled,m=method()){const j=new JVM({jit:{enabled:false,compileWorker:false,wasm:{structured:true,structuredIrreducibleSplitting:enabled}}}),w=j.jit.wasmJit;w.enabled=true;const st=w.methodState({method:m});w.compile({className:'SplitKernel',method:m},st,{entryPath:'regression'});return {j,m,w,st};}
test('bounded splitting admits structured Wasm for nested multiple-entry loops',async t=>{
 const off=harness(false);t.equal(off.st.structuredFailReason,'irreducible','ordinary structuring policy stays unchanged');
 const {j,m,w,st}=harness(true);
 t.equal(st.status,'ready','split module installed');
 t.ok(st.meta?.structured,'structured module owns execution');
 t.ok(st.meta?.normalFlowFullyCompiled,'all original normal flow remains compiled');
 t.ok(st.meta?.irreducibleSplitBlocks>0,'multiple-entry blocks actually duplicated');
 if(st.status!=='ready'){t.end();return;}
 const thread={id:0,status:'runnable',callStack:new Stack(),pendingException:null};j.threads=[thread];j.currentThreadIndex=0;
 for(const values of [[1,0,0],[3,0,0],[3,0,1],[5,4,1],[6,-20,0],[2,9,1],[40,-100,1]])for(const fuel of [undefined,1,2,5]){
  const caller=new Frame(m),frame=new Frame(m);frame.className='SplitKernel';values.forEach((v,i)=>frame.locals[i]=v);
  thread.callStack.push(caller);thread.callStack.push(frame);
  const run=st.run;if(fuel!==undefined)st.run=(...args)=>{args[args.length-1]=fuel;return run(...args);};
  const result=w.tryRunFrame(frame,thread);st.run=run;
  t.ok(result.handled,'fresh split frame entered');
  let ticks=0;while(thread.callStack.size()>1){await j.executeTick();if(++ticks>10000)throw Error('split resume tick limit');}
  t.equal(caller.stack.pop(),reference(...values),`nested(${values}) fuel=${fuel} resumes at the exact original PC`);thread.callStack.pop();
 }
 t.end();
});

test('split loops retain array effects exactly once across fuel exits',async t=>{
 const m=method();m.descriptor='(III[I)I';
 const code=m.attributes[0].code;code.localsSize='4';code.stackSize='4';
 code.codeItems=code.codeItems.flatMap(item=>{
  if(!['La:','Lb:'].includes(item.labelDef))return [item];
  const effects=['aload_3','iconst_0','dup2','iaload','iconst_1','iadd','iastore'];
  return [...effects.map((instruction,i)=>({instruction,labelDef:i===0?item.labelDef:undefined})),{...item,labelDef:undefined}];
 });
 const {j,w,st}=harness(true,m);
 t.ok(st.meta?.structured&&st.meta?.irreducibleSplitBlocks>0,'effectful split module installed');
 const thread={id:0,status:'runnable',callStack:new Stack(),pendingException:null};j.threads=[thread];j.currentThreadIndex=0;
 for(const values of [[3,0,0],[3,0,1],[5,4,1],[6,-20,0],[40,-100,1]])for(const fuel of [undefined,1,2,5]){
  let [n,acc,mode]=values,count=0;for(;;){n--;if(n<=0)break;let at=mode!==0;for(;;){count++;acc+=at?2:1;if(acc>=10)break;at=!at;}}
  const a=[0];a.type='[I';const caller=new Frame(m),frame=new Frame(m);frame.className='SplitKernel';[...values,a].forEach((v,i)=>frame.locals[i]=v);
  thread.callStack.push(caller);thread.callStack.push(frame);
  const run=st.run;if(fuel!==undefined)st.run=(...args)=>{args[args.length-1]=fuel;return run(...args);};
  t.ok(w.tryRunFrame(frame,thread).handled,'effectful split frame entered');st.run=run;
  let ticks=0;while(thread.callStack.size()>1){await j.executeTick();if(++ticks>10000)throw Error('effectful split resume limit');}
  t.equal(caller.stack.pop(),acc,'numeric result preserved');t.equal(a[0],count,'each visit mutates the array exactly once');thread.callStack.pop();
 }
 t.end();
});

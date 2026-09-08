'use strict';
const test=require('tape'),fs=require('fs'),os=require('os'),path=require('path');
const frontend=require('../src/java-frontend');
const {JVM}=require('../src/core/jvm');
const Stack=require('../src/core/stack');

test('wide restoring locals stay scalar without changing cold frame state',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wide-restoring-'));
 t.teardown(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const names=Array.from({length:56},(_,i)=>'v'+i);
 const source=`public class WideRestoring {
  static void run(int[] a,int n){
   ${names.map((v,i)=>`int ${v}=${i};`).join('\n')}
   for(int i=0;i<n;i++){
    ${names.map(v=>`${v}+=i;`).join('\n')}
    a[i]=${names.join('+')};
   }
  }
 }`;
 const file=path.join(dir,'WideRestoring.java');fs.writeFileSync(file,source);
 frontend.compileJavaFile(file,{outputDir:dir});
 const observations=[];
 for(const enabled of [false,true]){
  const j=new JVM({classpath:dir,jit:{compileWorker:false,profileMethods:false,
   structuredSsa:true,structuredWideCaptureFreeRestoring:enabled}});
  await j.preloadClasspathClasses();j._setClassInitializationState('WideRestoring','INITIALIZED');
  const method=j.findMethod(j.classes.WideRestoring,'run','([II)V');
  const g=j.jit.getGeneratedFunction(method,{allowEffectfulCalls:true,compileLocally:true});
  t.ok(g?.jvmRestoringDirectPositionalBody,'restoring body compiled');
  if(!g?.jvmRestoringDirectPositionalBody)continue;
  t.ok(g.jvmStructuredSpilledLocalCount>48,'fixture exceeds old capture-free slot limit');
  t.equal(g.jvmStructuredCaptureFreeRestoringSpills,enabled,'wide capture-free selection follows option');
  const rebound=j.jit.materializeGeneratedResult(j.jit.serializeGeneratedResult(g),method);
  t.ok(rebound?.jvmRestoringDirectPositionalBody,'wide body transports');
  for(const body of [g,rebound]){
   const invoke=j.jit.getPositionalGeneratedInvoker({op:'invokestatic',params:['int[]','int'],returnType:'void',descriptor:'([II)V',initializationToken:{initialized:true}},
    {method,lookupClass:'WideRestoring',generated:body,freeFrame:null});
   for(const count of [2,3]){
    const a=new Int32Array(2),thread={status:'runnable',callStack:new Stack()};let result,error;
    try{result=invoke(a,count,thread);}catch(e){error=e;}
    const state={pixels:[...a],error:!!error,reason:result?.reason||null,
     frames:thread.callStack.items.map(f=>({pc:f.pc,locals:f.locals.map(v=>v===a?'array':v),stack:f.stack.items.map(v=>v===a?'array':v)}))};
    t.deepEqual([...a],[1540,1596],'same guest arithmetic and array writes');
    if(count===3)t.ok(error,'array bounds failure still throws');
    else t.notOk(error,'valid execution does not throw');
    observations.push(state);
   }
  }
 }
 t.equal(observations.length,8,'all original and transported arms ran');
 for(let i=2;i<observations.length;i++)t.deepEqual(observations[i],observations[i%2],'result and precise restored locals/operands match baseline');
 t.end();
});

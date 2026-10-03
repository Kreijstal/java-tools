'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm');

function fixture(kind, unsafe) {
 const branch=kind==='tableswitch'
  ? {op:kind,defaultLbl:'safe',low:0,high:1,labels:['safe','unsafe']}
  : {op:kind,arg:{defaultLabel:'safe',pairs:[[100,'safe'],[1000,'unsafe']]}};
 return {name:'choose',descriptor:'(I)V',flags:['static'],attributes:[{type:'code',code:{
  localsSize:'1',stackSize:'2',exceptionTable:[],codeItems:[
   {instruction:'iload_0'}, {instruction:'ineg'}, {instruction:branch},
   {labelDef:'safe:',instruction:'return'},
   ...unsafe.map((instruction,index)=>({...(index===0?{labelDef:'unsafe:'}:{}),instruction})), {instruction:'return'},
  ],
 }}]};
}
for(const kind of ['tableswitch','lookupswitch']) {
 test(`${kind} admission examines non-fallthrough targets`,t=>{
  const j=new JVM({jit:{compileWorker:false,experimentalControlFlow:false}});
  const ctor=fixture(kind,[{op:'new',arg:'java/lang/Object'},'dup',{op:'invokespecial',arg:[null,'java/lang/Object',['<init>','()V']]},'pop']);
  t.notOk(j.jit.isCodegenSupported(ctor),'ordinary admission sees the constructor on a switch branch');
  const throws=fixture(kind,[{op:'invokestatic',arg:[null,'Host',['touch','()V']]},'aconst_null','athrow']);
  t.notOk(j.jit.hasJitSafeControlFlow(throws,j.jit.getCodeItems(throws)),'leaf-flow proof sees the call on the throwing switch branch');
  t.notOk(j.jit.isCodegenSupported(throws),'exception-flow admission includes the throwing switch branch');
  t.ok(j.jit.isCodegenSupported(fixture(kind,['nop'])),'a numeric switch without unsafe calls remains eligible');
  t.end();
 });
}

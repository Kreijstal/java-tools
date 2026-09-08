'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm');

for(const prepared of [false,true])test(`integer scalar selection matches dispatcher, prepared Wasm ${prepared}`,t=>{
 const j=new JVM({jit:{compileWorker:false}}),jit=j.jit;
 const method={name:'arithmetic',descriptor:'(I)I',attributes:[]};
 const site={op:'invokevirtual',params:['int'],returnType:'int',descriptor:'(I)I'};
 const region=()=>7, direct=()=>7;
 jit.hasReadyFullWasm=()=>true;
 jit.hasPreparedFullWasmUpgrade=()=>prepared;
 jit.readyWasmProvenUnusedForTarget=()=>false;
 jit.getDirectInlineIntegerRegion=(m,params,result)=>{
  t.equal(m,method,'uses the already selected method');return direct;
 };
 const target={method,lookupClass:'Fixture',inlineIntegerRegion:region};
 t.equal(jit.getPositionalGeneratedInvoker(site,target),direct,
  'a ready unused Wasm module cannot force integer calls through a frame');
 t.equal(direct.jvmSafePointCharge,1,'published call retains safe-point accounting');
 t.equal(jit.getPositionalGeneratedInvoker(site,{method,lookupClass:'Fixture'}),null,
  'ordinary generated targets retain the Wasm selection veto');
 t.end();
});

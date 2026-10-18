'use strict';
const test=require('tape');
const {T,OP,uleb,sleb,f32bytes,f64bytes,STRUCTURED_RETURN,CAPTURE_DIRECT_ID,
 definedGlobal,assembleModule,supportsWasmTryTable}=require('../src/jit/wasmShared');

test('imported canonical fuel preserves every wrapper and defined-global index',t=>{
 if(!supportsWasmTryTable()){t.pass('engine retains legacy wrappers');t.end();return;}
 for(const type of [null,T.i32,T.i64,T.f32,T.f64])for(const count of [1,128]){
  const fuel=new WebAssembly.Global({value:'i32',mutable:true},29),owner={},value=type===T.i64?15n:15;
  const globalImportDecls=Array.from({length:count},(_,i)=>({name:'fuel'+i,type:T.i32,mutable:true}));
  const env=Object.fromEntries(globalImportDecls.map(d=>[d.name,fuel]));
  const observed=[];env.ready=()=>1;env.observe=(...args)=>observed.push(args);
  let fail=false;env.thrower=()=>{if(fail)throw Error('test exception');};
  const literal=type===T.i64?[OP.i64_const,...sleb(15)]:type===T.f32?[OP.f32_const,...f32bytes(15)]:
   type===T.f64?[OP.f64_const,...f64bytes(15)]:[OP.i32_const,15];
  // Retv, specok, then active id, entry count, owner. Literal 15 equals
  // return's opcode, and imported indices cross the single-byte LEB boundary.
  const body=[CAPTURE_DIRECT_ID,OP.call,2];
  for(let i=1;i<=5;i++)body.push(OP.local_get,i);
  body.push(OP.call,1,...(type?[...literal,...definedGlobal(OP.global_set,0)]:[]),
   ...definedGlobal(OP.global_get,type?1:0),OP.drop,OP.i32_const,...sleb(-1),STRUCTURED_RETURN,OP.end);
  const x=new WebAssembly.Instance(new WebAssembly.Module(assembleModule({
   importDecls:[{name:'ready',params:[],results:[T.i32]},
    {name:'observe',params:Array(5).fill(T.i32),results:[]},{name:'thrower',params:[],results:[]}],
   globalImportDecls,mainParams:[T.ref,T.i32,T.i32,T.i32,T.i32],mainResults:[T.i32],declared:[T.i32],body,
   retvType:type,runvWrapper:true,specokGlobal:true,parameterArrayABI:[0],
   canonicalFrameExport:{readyIdx:0,compact:true,inlineCompact:true,idLocal:5,fuelImportIndex:count-1}})),{env}).exports;
  x.canonicalOwner.value=owner;
  t.equal(x.canonicalFuel,fuel,'export is the host global itself');
  t.equal(x.run(null,8,17),-1,'public run keeps block and fuel ABI');
  t.deepEqual(observed.pop(),[-2,0,8,17,0],'public arguments retain indices');
  t.deepEqual(type?x.runv(null):[x.runv(null)],[-1,...(type?[value]:[])],'runv result global is relocated');
  for(const entry of ['canonicalRun','canonicalHeapRun','canonicalCompactRun','canonicalCompactHeapRun']){
   const compact=entry.includes('Compact'),expanded=entry.includes('Heap'),args=expanded?[null,48,7]:[null];
   const result=x[entry](...args),id=x.canonicalEntries.value;
   t.deepEqual(type||!compact?result:[result],[-1,...(compact?[]:[id,owner]),...(type?[value]:[])],entry+' returns exact ABI');
   t.deepEqual(observed.pop(),[...(expanded?[48,7]:[-2,0]),0,29,id],entry+' receives imported fuel');
  }
  fail=true;
  for(const entry of ['canonicalCompactRun','canonicalCompactHeapRun']){
   const result=x[entry](null,48,7);
   t.deepEqual(type?result:[result],[-5,...(type?[value]:[])],entry+' catch reads the relocated result');
  }
  Object.getOwnPropertyDescriptor(WebAssembly.Global.prototype,'value').set.call(fuel,1);
  fail=false;x.canonicalCompactRun(null);t.equal(observed.pop()[3],1,'native caller sees prototype-set fuel changes');
 }
 t.throws(()=>assembleModule({importDecls:[],mainParams:[],mainResults:[],declared:[],body:[OP.end],
  canonicalFrameExport:{fuelImportIndex:0}}),/mutable i32/,'missing imported fuel is refused');
 t.end();
});

test('reference runv clears its relocated return scratch with imported globals',t=>{
 const fuel=new WebAssembly.Global({value:'i32',mutable:true},17),value={returned:true};
 const x=new WebAssembly.Instance(new WebAssembly.Module(assembleModule({importDecls:[],
  globalImportDecls:[{name:'fuel',type:T.i32,mutable:true}],mainParams:[T.ref,T.i32,T.i32],mainResults:[T.i32],
  declared:[],retvType:T.ref,runvWrapper:true,
  body:[OP.local_get,0,...definedGlobal(OP.global_set,0),OP.i32_const,...sleb(-1),OP.end]})),{env:{fuel}}).exports;
 t.deepEqual(x.runv(value),[-1,value],'reference result is exact');
 t.equal(x.retv.value,null,'result scratch owns no extra reference');
 t.equal(fuel.value,17,'return scratch does not overwrite the imported fuel');
 t.end();
});

test('importing host-owned fuel does not retain the retired exporting module',async t=>{
 if(!global.gc||!supportsWasmTryTable()){t.pass('needs forced GC and supported Wasm');t.end();return;}
 const create=()=>{
  const owner={retired:true},fuel=new WebAssembly.Global({value:'i32',mutable:true},37);
  const module=new WebAssembly.Module(assembleModule({
   importDecls:[{name:'ready',params:[],results:[T.i32]}],
   globalImportDecls:[{name:'fuel',type:T.i32,mutable:true}],
   mainParams:[T.i32,T.i32],mainResults:[T.i32],declared:[T.i32],
   body:[CAPTURE_DIRECT_ID,OP.i32_const,...sleb(-1),STRUCTURED_RETURN,OP.end],
   canonicalFrameExport:{readyIdx:0,compact:true,inlineCompact:true,idLocal:2,fuelImportIndex:0}}));
  const instance=new WebAssembly.Instance(module,{env:{fuel,ready:()=>owner.retired?1:0}});
  instance.exports.canonicalOwner.value=owner;
  const read=new WebAssembly.Instance(new WebAssembly.Module(assembleModule({importDecls:[],
   globalImportDecls:[{name:'fuel',type:T.i32,mutable:true}],mainParams:[],mainResults:[T.i32],declared:[],
   body:[OP.global_get,0,OP.end]})),{env:{fuel:instance.exports.canonicalFuel}}).exports.run;
  return {fuel,read,owner:new WeakRef(owner),run:new WeakRef(instance.exports.canonicalCompactRun),
   instance:new WeakRef(instance),module:new WeakRef(module)};
 };
 const kept=create();for(let i=0;i<12;i++){await new Promise(setImmediate);global.gc();}
 for(const key of ['owner','run','instance','module'])t.equal(kept[key].deref(),undefined,key+' is collectible while fuel stays imported');
 t.equal(kept.read(),37,'surviving caller reads the fuel');
 kept.fuel.value=2;t.equal(kept.read(),2,'surviving caller observes current fuel');
 t.end();
});

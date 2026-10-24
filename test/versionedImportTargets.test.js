'use strict';
const test=require('tape');
const {T,OP,uleb,sleb,assembleModule}=require('../src/jit/wasmShared');
const {nativeObjectStorageTypes,getNativeObjectStorageOps}=require('../src/core/nativeObjectStorage');

// A compile-time bound Wasm import can keep the caller's small function graph.
// A live version/dispatch check selects the existing table on every mismatch.
// This is an ABI proof, not runtime integration or a performance claim.
function callerBytes(params,results,{expected=0,slot=0,padding=0,gcTypes=[],twice=false}={}){
 const sigTypes=Array.from({length:padding},(_,n)=>({params:Array(n).fill(T.i32),results:[]}));
 sigTypes.push({params,results});const signature=gcTypes.length+padding;
 const invoke=()=>[...params.flatMap((_,i)=>[OP.local_get,...uleb(i)]),
  OP.local_get,...uleb(params.length),OP.i32_const,...sleb(slot),OP.i32_eq,
  OP.global_get,0,OP.i32_const,...sleb(expected),OP.i32_eq,OP.i32_and,
  OP.if,...sleb(signature),OP.call,0,OP.else,
  OP.local_get,...uleb(params.length),OP.call_indirect,...uleb(signature),0,OP.end];
 const body=twice?[...invoke(),OP.local_set,2,OP.drop,...invoke(),OP.local_set,3,OP.drop,OP.local_get,2,OP.local_get,3,OP.end]:[...invoke(),OP.end];
 return assembleModule({importDecls:[{name:'fast',params,results}],mainParams:[...params,T.i32],mainResults:results,
  declared:twice?[T.i32,T.i32]:[],body,importCanonicalTable:true,
  globalImportDecls:[{name:'version',type:T.i32,mutable:true}],sigTypes,gcTypes});
}
function target(params,results,body,{gcTypes=[],imports=[],env={}}={}){
 return new WebAssembly.Instance(new WebAssembly.Module(assembleModule({importDecls:imports,
  mainParams:params,mainResults:results,declared:[],body:[...body,OP.end],gcTypes})),{env}).exports.run;
}
function bind(bytes,fast,table,version){return new WebAssembly.Instance(new WebAssembly.Module(bytes),{env:{fast,ctab:table,version}}).exports.run;}

test('versioned direct imports preserve dispatch, replacement and withdrawal',t=>{
 const params=[T.i32],results=[T.i32,T.i32],body=value=>[OP.i32_const,...sleb(-1),OP.local_get,0,OP.i32_const,...sleb(value),OP.i32_add];
 const first=target(params,results,body(3)),second=target(params,results,body(9));
 const fallback=target(params,results,[OP.i32_const,...sleb(-6),OP.local_get,0]);
 const other=target(params,results,body(20)),table=new WebAssembly.Table({element:'anyfunc',initial:2});table.set(0,first);table.set(1,other);
 const version=new WebAssembly.Global({value:'i32',mutable:true},0),bytes=callerBytes(params,results),run=bind(bytes,first,table,version);
 t.deepEqual(run(7,0),[-1,10],'ready fixed dispatch uses its direct import');
 t.deepEqual(run(7,1),[-1,27],'a different dispatch slot retains the exact table target');
 table.set(0,second);version.value=1;
 t.deepEqual(run(7,0),[-1,16],'replacement reaches the newly published export');
 table.set(0,fallback);version.value=2;
 t.deepEqual(run(7,0),[-6,7],'withdrawal preserves the established fallback status and value');
 table.set(0,second);version.value=3;
 t.deepEqual(run(7,0),[-1,16],'republication never calls the captured old target');
 const wrong=target(params,[T.i32],[OP.local_get,0]);table.set(0,wrong);version.value=4;
 t.throws(()=>run(7,0),WebAssembly.RuntimeError,'incompatible table publications retain native signature checks');
 const imports=WebAssembly.Module.imports(new WebAssembly.Module(bytes));
 t.equal(imports.filter(x=>x.kind==='function').length,1,'caller binds one Wasm function directly');
 t.equal(imports.filter(x=>x.kind==='table').length,1,'existing mutable dispatch remains available');
 t.end();
});

test('version is checked again after a callback within one native invocation',t=>{
 const params=[T.i32],results=[T.i32,T.i32],version=new WebAssembly.Global({value:'i32',mutable:true},0);
 const table=new WebAssembly.Table({element:'anyfunc',initial:1}),second=target(params,results,[OP.i32_const,...sleb(-1),OP.i32_const,9]);let calls=0;
 const first=target(params,results,[OP.call,0,OP.i32_const,...sleb(-1),OP.i32_const,3],{
  imports:[{name:'replace',params:[],results:[]}],env:{replace(){calls++;table.set(0,second);version.value=1;}}});
 table.set(0,first);const run=bind(callerBytes(params,results,{twice:true}),first,table,version);
 t.deepEqual(run(7,0),[3,9],'first activation completes once and the next call uses the replacement');
 t.equal(calls,1,'retired direct target does not execute again after the callback');t.end();
});

test('direct/table joins preserve reference, wide and native storage payloads',t=>{
 const storage=getNativeObjectStorageOps().create(123,7,0),marker={owner:1};
 const specs=[
  {params:[T.ref],results:[T.i32,T.ref],body:[OP.i32_const,...sleb(-1),OP.local_get,0],args:[marker]},
  {params:[T.i64,T.f64],results:[T.i32,T.i64,T.f64],body:[OP.i32_const,...sleb(-1),OP.local_get,0,OP.local_get,1],args:[9007199254740993n,-0]},
  {params:[T.ref,[0x63,1]],results:[T.i32,T.ref,T.i32],body:[OP.i32_const,...sleb(-1),OP.local_get,0,OP.local_get,1,0xfb,2,1,0],
   args:[marker,storage],gcTypes:nativeObjectStorageTypes()},
 ];
 for(const spec of specs){
  const options={gcTypes:spec.gcTypes||[]},fn=target(spec.params,spec.results,spec.body,options);
  const table=new WebAssembly.Table({element:'anyfunc',initial:1});table.set(0,fn);
  const version=new WebAssembly.Global({value:'i32',mutable:true},0),run=bind(callerBytes(spec.params,spec.results,options),fn,table,version);
  for(const epoch of [0,1]){version.value=epoch;const out=run(...spec.args,0);
   t.equal(out[0],-1,'status survives the '+(epoch?'table':'direct')+' arm');
   t.equal(out[1],spec.args[0],'reference identity or wide bits survive the join');
   if(out.length===3)t.ok(Object.is(out[2],spec.gcTypes?123:-0),'third result preserves signed zero/native storage data');
  }
 }
 t.end();
});

test('high block type indices and raw throw identities remain valid',t=>{
 const params=[T.i32],results=[T.i32,T.i32],error={exactThrow:1};
 const fn=target(params,results,[OP.call,0,OP.i32_const,0,OP.local_get,0],{
  imports:[{name:'fail',params:[],results:[]}],env:{fail(){throw error;}}});
 const table=new WebAssembly.Table({element:'anyfunc',initial:1});table.set(0,fn);
 const version=new WebAssembly.Global({value:'i32',mutable:true},0),bytes=callerBytes(params,results,{padding:70});
 t.ok(WebAssembly.validate(bytes),'typed if uses signed LEB for type indices above 63');
 const run=bind(bytes,fn,table,version);
 t.throws(()=>run(7,0),e=>e===error,'direct import retains the original thrown value');
 version.value=1;t.throws(()=>run(7,0),e=>e===error,'table fallback retains the same thrown value');t.end();
});

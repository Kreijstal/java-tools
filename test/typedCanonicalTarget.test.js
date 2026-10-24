'use strict';
const test=require('tape');
const {T,OP,uleb,sleb,assembleModule}=require('../src/jit/wasmShared');
const {nativeObjectStorageTypes,getNativeObjectStorageOps}=require('../src/core/nativeObjectStorage');

// Proof of concept: a typed, non-null function global checks replacement once.
// The consumer uses call_ref with a known type, without an untyped table.
const vector=xs=>[...uleb(xs.length),...xs.flat()];
const section=(id,xs)=>[id,...uleb(xs.length),...xs];
const name=s=>[...uleb(s.length),...Buffer.from(s)];
function cellBytes(params,results,gcTypes=[],consumer=false){
 const signature=gcTypes.length,type=[0x60,...uleb(params.length),...params.flat(),...uleb(results.length),...results.flat()];
 const reference=[0x64,...sleb(signature)],imports=consumer?
  [[...name('env'),...name('target'),3,...reference,1]]:
  [[...name('env'),...name('initial'),0,...uleb(signature)]];
 const body=[0,...params.flatMap((_,i)=>[OP.local_get,...uleb(i)]),
  OP.global_get,0,0x14,...uleb(signature),OP.end];
 const exports=consumer?[[...name('run'),0,0]]:
  [[...name('initial'),0,0],[...name('target'),3,0],[...name('run'),0,1]];
 return Uint8Array.from([0,97,115,109,1,0,0,0,...section(1,vector([...gcTypes,type])),
  ...section(2,vector(imports)),...section(3,vector([[...uleb(signature)]])),
  ...(!consumer?section(6,vector([[...reference,1,0xd2,0,OP.end]])):[]),
  ...section(7,vector(exports)),...section(10,vector([[...uleb(body.length),...body]]))]);
}
const target=(params,results,body,gcTypes=[])=>new WebAssembly.Instance(new WebAssembly.Module(
 assembleModule({importDecls:[],mainParams:params,mainResults:results,declared:[],body:[...body,OP.end],gcTypes}))).exports.run;

test('typed canonical target replacement rejects wrong signatures before invocation',t=>{
 const params=[T.i32],results=[T.i32,T.i32];
 const initial=target(params,results,[OP.i32_const,...sleb(-6),OP.local_get,0]);
 const bytes=cellBytes(params,results);
 t.ok(WebAssembly.validate(bytes),'non-null function global and call_ref validate without flags');
 const cell=new WebAssembly.Instance(new WebAssembly.Module(bytes),{env:{initial}}).exports;
 const caller=new WebAssembly.Instance(new WebAssembly.Module(cellBytes(params,results,[],true)),{env:{target:cell.target}}).exports.run;
 t.deepEqual(caller(7),[-6,7],'new cell starts on its established fallback');
 const ready=target(params,results,[OP.i32_const,...sleb(-1),OP.local_get,0,OP.i32_const,3,OP.i32_add]);
 cell.target.value=ready;t.deepEqual(caller(7),[-1,10],'publication changes an already installed native caller');
 const wrong=target(params,[T.i32],[OP.local_get,0]);
 t.throws(()=>{cell.target.value=wrong;},TypeError,'wrong result signature is rejected at publication');
 t.throws(()=>{cell.target.value=null;},TypeError,'non-null target cannot lose its established fallback');
 t.deepEqual(caller(9),[-1,12],'rejected publication cannot replace the live target');
 cell.target.value=initial;t.deepEqual(caller(9),[-6,9],'withdrawal restores the original fallback');
 t.equal(WebAssembly.Module.imports(new WebAssembly.Module(cellBytes(params,results,[],true))).filter(x=>x.kind==='table').length,0,'consumer imports no untyped function table');
 t.end();
});

test('typed target cells retain mixed result bits and native storage signatures',t=>{
 for(const spec of [
  {params:[T.ref],results:[T.i32,T.ref],body:[OP.i32_const,...sleb(-1),OP.local_get,0],args:[{marker:7}]},
  {params:[T.i64,T.f64],results:[T.i32,T.i64,T.f64],body:[OP.i32_const,...sleb(-1),OP.local_get,0,OP.local_get,1],args:[9007199254740993n,-0]},
  {params:[T.ref,[0x63,1]],results:[T.i32,T.ref,T.i32],body:[OP.i32_const,...sleb(-1),OP.local_get,0,OP.local_get,1,0xfb,2,1,0],
   gcTypes:nativeObjectStorageTypes(),args:[{receiver:3},getNativeObjectStorageOps().create(1234,7,0)]},
 ]){
  const gc=spec.gcTypes||[],fn=target(spec.params,spec.results,spec.body,gc);
  const cell=new WebAssembly.Instance(new WebAssembly.Module(cellBytes(spec.params,spec.results,gc)),{env:{initial:fn}}).exports;
  const caller=new WebAssembly.Instance(new WebAssembly.Module(cellBytes(spec.params,spec.results,gc,true)),{env:{target:cell.target}}).exports.run;
  const result=caller(...spec.args);t.equal(result[0],-1,'status survives the typed native boundary');
  t.equal(result[1],spec.args[0],'reference identity or wide integer bits remain exact');
  if(spec.results.length===3)t.ok(Object.is(result[2],gc.length?1234:-0),'third result retains exact native data');
 }
 t.end();
});

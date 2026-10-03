'use strict';
const test=require('tape');
const Buffers=require('../src/jit/NestedArgumentBuffers');
const Compiler=require('../src/jit/StructuredWasmCompiler');
const {T}=require('../src/jit/wasmShared');

test('nested argument buffers retain one cleared buffer per module',t=>{
 const pool=new Buffers(),key={},other={};
 const outer=pool.acquire(key,4),ref={};outer.values[0]=ref;outer.values[1]=17n;
 const inner=pool.acquire(key,4);inner.values[0]=other;
 t.notEqual(inner,outer,'recursive entry owns distinct storage');
 t.equal(outer.values[0],ref,'recursive entry preserves outer arguments');
 pool.release(inner);t.ok(inner.values.every(v=>v===0),'recursive references cleared');
 t.equal(pool.buffers.get(key),outer,'recursive storage is not retained');
 pool.release(outer);t.ok(outer.values.every(v=>v===0),'outer references and bigint cleared');
 t.equal(pool.acquire(key,4),outer,'idle buffer reused');pool.release(outer);
 t.notEqual(pool.acquire(other,4),outer,'modules cannot share live storage');
 const resized=pool.acquire(key,6);t.equal(resized.values.length,6,'layout replacement uses correct arity');
 t.equal(pool.buffers.get(key),resized,'only replacement retained for changed layout');
 t.end();
});

test('structured nested calls release buffers on return, recursion and exceptions',t=>{
 const c=Object.create(Compiler.prototype),pool=new Buffers(),saved={};
 c.wasmJit={nestedArgumentBuffers:pool,revalidateNestedCallee:()=>true};c.box={};
 const meta={fullyCompiled:true,paramSlots:[{slot:0,t:T.ref},{slot:2,t:T.i64},{slot:3,t:T.i32}],
  box:{frame:saved},retChar:'I'};
 const state={meta,key:'Probe.call'},positions=new Map([[0,0]]),scratch=new Map();
 const reference={};let depth=0,outerBuffer;
 state.run=(ref,wide,narrow,pc,fuel)=>{
  t.equal(ref,reference,'reference argument identity');t.equal(wide,0n,'unmapped wide slot zero');
  t.equal(narrow,0,'unmapped integer slot zero');t.equal(pc,0,'entry block preserved');t.equal(fuel,100000000,'fuel preserved');
  if(!depth++) {
   outerBuffer=pool.buffers.get(meta);
   t.equal(c.runNested(state,'Probe',[reference],positions,scratch,0),23,'recursive result');
   t.equal(outerBuffer.values[0],reference,'outer arguments survive recursion');
  }
  meta.box.ret=23;return -1;
 };
 t.equal(c.runNested(state,'Probe',[reference],positions,scratch,0),23,'normal result');
 t.equal(meta.box.frame,saved,'box frame restored');
 t.ok(outerBuffer.values.every(v=>v===0),'all references retired');
 const failure=new Error('callee failed');state.run=()=>{throw failure;};
 t.throws(()=>c.runNested(state,'Probe',[reference],positions,scratch,0),e=>e===failure,'exact exception propagates');
 t.equal(meta.box.frame,saved,'exception restores box frame');
 t.notOk(outerBuffer.inUse,'exception releases busy flag');
 t.ok(outerBuffer.values.every(v=>v===0),'exception releases argument references');
 const argumentsWithGetter=[];Object.defineProperty(argumentsWithGetter,0,{get(){throw failure;}});
 t.throws(()=>c.runNested(state,'Probe',argumentsWithGetter,positions,scratch,0),e=>e===failure,'argument preparation exception propagates');
 t.notOk(outerBuffer.inUse,'preparation failure also releases buffer');
 t.ok(outerBuffer.values.every(v=>v===0),'preparation failure retains nothing');
 t.end();
});

'use strict';
const {T,OP,uleb,sleb,getOp}=require('./wasmShared');
const {heapCopyKind}=require('./WasmArrayCopy');
const {addFieldImport}=require('./wasmRuntimeImports');
function normalize(method) {
 const code=method.attributes?.find(a=>a.type==='code')?.code;
 if(!code||code.exceptionTable?.length)return null;
 const ins=[],labels=new Map();
 for(const i of code.codeItems){if(i.labelDef)labels.set(i.labelDef.replace(/:$/,''),ins.length);if(i.instruction)ins.push(i.instruction);}
 return ins.map(i=>{
  const op=getOp(i),local=/^(iload|istore)_([0-3])$/.exec(op),constant=/^iconst_([0-5])$/.exec(op);
  if(local)return [local[1],Number(local[2])];
  if(constant)return ['const',Number(constant[1])];
  if(['bipush','sipush'].includes(op))return ['const',Number(i.arg)];
  if(['iload','istore'].includes(op))return [op,Number(i.varnum??i.arg)];
  if(op==='iinc')return [op,Number(i.varnum),Number(i.incr)];
  if(op==='goto'||op.startsWith('if_'))return [op,labels.get(String(i.arg).replace(/:$/,''))];
  if(op==='getstatic')return [op,i.arg];
  return [op];
 });
}
function recognizeIntZeroClear(method) {
 if(method.descriptor!=='()V'||!method.flags?.includes('static')||method.flags.includes('synchronized'))return null;
 const a=normalize(method);if(!a||a.length<30)return null;
 const width=a[5]?.[1]+1,dims=[a[2]?.[1],a[3]?.[1]],array=a[11]?.[1];
 const valid=(f,d)=>Array.isArray(f)&&f[0]==='Field'&&Array.isArray(f[2])&&f[2][1]===d;
 if(!Number.isInteger(width)||width<2||width>16||!dims.every(f=>valid(f,'I'))||!valid(array,'[I')||dims.some(f=>f[1]!==array[1]))return null;
 const e=[],labels=new Map(),add=(...x)=>e.push(x),mark=n=>labels.set(n,e.length);
 const store=()=>{add('getstatic',array);add('iload',0);add('iinc',0,1);add('const',0);add('iastore');};
 add('const',0);add('istore',0);add('getstatic',dims[0]);add('getstatic',dims[1]);add('imul');add('const',width-1);add('isub');add('istore',1);
 mark('bulk');add('iload',0);add('iload',1);add('if_icmpge','tailSetup');for(let i=0;i<width;i++)store();add('goto','bulk');
 mark('tailSetup');add('iinc',1,width-1);mark('tail');add('iload',0);add('iload',1);add('if_icmpge','done');store();add('goto','tail');mark('done');add('return');
 for(const x of e)if(x[0]==='goto'||x[0].startsWith('if_'))x[1]=labels.get(x[1]);
 if(JSON.stringify(a)!==JSON.stringify(e))return null;
 return {width,dims,array};
}
function emitIntZeroClearEntry(c) {
 if(!c.wasmJit.intZeroClearEntryEnabled||!c.heap||c.demoted.size||c.deoptBlocks.size)return [];
 const plan=recognizeIntZeroClear(c.method);if(!plan)return [];
 const owner=plan.array[1],cd=c.jvm.classes[owner];
 for(const f of [...plan.dims,plan.array]){
  const decl=cd?.ast?.classes?.[0]?.items?.find(i=>i.type==='field'&&i.field.name===f[2][0]&&i.field.descriptor===f[2][1])?.field;
  if(!decl?.flags?.includes('static')||decl.flags.includes('volatile'))return [];
 }
 const imports=plan.dims.map(arg=>addFieldImport(c,c.jvm,{arg},true,true));
 const array=addFieldImport(c,c.jvm,{arg:plan.array},true,true);
 const local=t=>{const k=c.nextLocal++;c.declared.push(t);return k;};
 const n=local(T.i32),arrayLocal=local(T.ref),base=local(T.i32),length=local(T.i32),cost=local(T.i32);
 const get=k=>[OP.local_get,...uleb(k)],set=k=>[OP.local_set,...uleb(k)],iconst=v=>[OP.i32_const,...sleb(v)];
 const kind=c.addImport('zero_clear_int_heap',[T.ref],[T.i32],a=>heapCopyKind(c.heap,a)===0x54?1:0);
 const box=c.box;const count=c.addImport('zero_clear_count',[T.i32],[],n=>{box.intZeroClearCalls=(box.intZeroClearCalls||0)+1;box.intZeroClearElements=(box.intZeroClearElements||0)+n;});
 const calls=()=>imports.flatMap(f=>[OP.call,...uleb(f.idx)]);
 const guards=[...get(c.blkLocal),OP.i32_eqz];
 const readiness=imports[0].initializationIdx;
 if(readiness!==null)guards.push(OP.call,...uleb(readiness),OP.i32_and);
 const out=[...guards,OP.if,0x40,...calls(),OP.i32_mul,...set(n),
  ...get(n),...iconst(0),OP.i32_ge_s,...get(n),...iconst(1048576),OP.i32_le_s,OP.i32_and,OP.if,0x40,
  ...get(n),...iconst(plan.width),OP.i32_div_s,...get(n),...iconst(plan.width),OP.i32_rem_s,OP.i32_add,...iconst(2),OP.i32_add,...set(cost),
  ...get(c.fuelLocal),...get(cost),OP.i32_gt_s,OP.if,0x40,
  ...get(n),OP.i32_eqz,OP.if,0x40,...get(c.fuelLocal),...get(cost),OP.i32_sub,...set(c.fuelLocal),...iconst(-1),OP.return,OP.end,
  OP.call,...uleb(array.idx),...set(arrayLocal),
  ...get(arrayLocal),OP.call,...uleb(kind),OP.if,0x40,
  ...get(arrayLocal),OP.call,...uleb(c.abaseIdx),...set(base),
  ...get(arrayLocal),OP.call,...uleb(c.alen0Idx),...set(length),
  ...get(length),...get(n),OP.i32_ge_u,OP.if,0x40,
  ...get(base),...iconst(0),...get(n),...iconst(2),OP.i32_shl,0xfc,0x0b,0x00,
  ...get(c.fuelLocal),...get(cost),OP.i32_sub,...set(c.fuelLocal),...get(n),OP.call,...uleb(count),...iconst(-1),OP.return,
  OP.end,OP.end,OP.end,OP.end,OP.end];
 c.intZeroClearEntryBytes=out.length;c.intZeroClearEntryUnroll=plan.width;c.usedHeap=true;
 return out;
}
module.exports={recognizeIntZeroClear,emitIntZeroClearEntry};

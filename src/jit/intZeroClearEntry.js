'use strict';
const {T,OP,STRUCTURED_RETURN,uleb,sleb,getOp}=require('./wasmShared');
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
// Interpret only straight-line local arithmetic and zero stores. Local copies
// and dead initializations have no observable effects, so the proof does not
// depend on javac's temporary-slot allocation or a decompiler's spelling.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const constant = n => ['constant', n];
function offset(value, delta) {
 if (value?.[0] === 'constant') return constant((value[1] + delta) | 0);
 if (value?.[0] === 'offset') return offset(value[1], value[2] + delta);
 return delta === 0 ? value : ['offset', value, delta];
}
function straightLine(code, from, end, locals) {
 const stack = [], stores = [], inputs = new Set(), writes = new Set();
 const pop = () => { if (!stack.length) throw Error('empty proof stack'); return stack.pop(); };
 try {
  for (let i = from; i < end; i++) {
   const [op, arg, by] = code[i];
   if (op === 'const') stack.push(constant(arg));
   else if (op === 'iload') {
    if (!locals.has(arg)) return null;
    if (!writes.has(arg)) inputs.add(arg);
    stack.push(locals.get(arg));
   } else if (op === 'istore') { locals.set(arg, pop()); writes.add(arg); }
   else if (op === 'iinc') {
    if (!locals.has(arg)) return null;
    if (!writes.has(arg)) inputs.add(arg);
    locals.set(arg, offset(locals.get(arg), by));
    writes.add(arg);
   } else if (op === 'getstatic') stack.push(['field', arg]);
   else if (op === 'iadd' || op === 'isub' || op === 'imul') {
    const right = pop(), left = pop();
    if (op === 'iadd' && right[0] === 'constant') stack.push(offset(left, right[1]));
    else if (op === 'isub' && right[0] === 'constant') stack.push(offset(left, -right[1]));
    else if (op === 'imul') stack.push(['multiply', left, right]);
    else return null;
   } else if (op === 'iastore') {
    const value = pop(), index = pop(), array = pop();
    stores.push({array, index, value});
   } else return null;
  }
 } catch (_) { return null; }
 return stack.length ? null : {stores, inputs, writes};
}
function recognizeIntZeroClear(method) {
 if(method.descriptor !== '()V' || !method.flags?.includes('static') ||
    method.flags.includes('synchronized')) return null;
 const a = normalize(method);
 if (!a) return null;
 // Exactly two ordinary counted loops: an unrolled body followed by its
 // scalar tail. All other instructions must pass the straight-line proof.
 const backs = a.map((x, i) => x[0] === 'goto' && x[1] < i ? [x[1], i] : null).filter(Boolean);
 if (backs.length !== 2) return null;
 const [[head, back], [tail, tailBack]] = backs;
 const loop = (h, b) => a[h]?.[0] === 'iload' && a[h+1]?.[0] === 'iload' &&
   a[h+2]?.[0] === 'if_icmpge' && a[h+2][1] === b+1;
 if (!(head < back && back < tail && tail < tailBack) ||
     !loop(head, back) || !loop(tail, tailBack) ||
     !same(a[head], a[tail]) || !same(a[head+1], a[tail+1]) ||
     tailBack+2 !== a.length || a.at(-1)[0] !== 'return') return null;
 const index = a[head][1], bound = a[head+1][1];
 if (index === bound) return null;
 const entry = new Map();
 const initial = straightLine(a, 0, head, entry);
 if (!initial || initial.stores.length || !same(entry.get(index), constant(0))) return null;
 const base = ['bulkIndex'];
 const body = new Map(entry); body.set(index, base);
 const bulk = straightLine(a, head+3, back, body), stores = bulk?.stores;
 const width = stores?.length;
 if (!(width >= 2 && width <= 16) || !same(body.get(index), offset(base, width)) ||
     !same(body.get(bound), entry.get(bound))) return null;
 if ([...bulk.inputs].some(slot => slot !== index &&
     !same(body.get(slot), entry.get(slot)))) return null;
 const array = stores[0].array;
 if (!stores.every((s, i) => same(s.array, array) && same(s.index, offset(base, i)) &&
     same(s.value, constant(0)))) return null;
 const threshold = entry.get(bound);
 if (threshold?.[0] !== 'offset' || threshold[2] !== 1-width ||
     threshold[1]?.[0] !== 'multiply') return null;
 const dims = threshold[1].slice(1);
 const validField = (f, descriptor) => f?.[0] === 'field' &&
   Array.isArray(f[1]) && f[1][0] === 'Field' && f[1][2]?.[1] === descriptor;
 if (!validField(array, '[I') || !dims.every(f => validField(f, 'I')) ||
     dims.some(f => f[1][1] !== array[1][1])) return null;
 // Even a discarded static read can initialize a different class. The
 // compact entry only guards and reads the dependencies proved here.
 const dependencies = [array[1], ...dims.map(f => f[1])];
 if (a.some(([op, field]) => op === 'getstatic' &&
     !dependencies.some(expected => same(field, expected)))) return null;
 // A tail setup may update the bound and temporary locals, but must not
 // change the first index that the unrolled loop left unfilled.
 const afterBulk = ['afterBulk'], tailEntry = new Map(entry);
 // The bulk loop may run zero, one, or many times. A temporary it writes
 // has no single known value at the tail, even when its first iteration did.
 for (const slot of bulk.writes) tailEntry.set(slot, ['afterBulkLocal', slot]);
 tailEntry.set(index, afterBulk); tailEntry.set(bound, entry.get(bound));
 const setup = straightLine(a, back+1, tail, tailEntry);
 if (!setup || setup.stores.length || !same(tailEntry.get(index), afterBulk) ||
     !same(tailEntry.get(bound), threshold[1])) return null;
 const tailBase = ['tailIndex'], tailBody = new Map(tailEntry);
 tailBody.set(index, tailBase);
 const remainder = straightLine(a, tail+3, tailBack, tailBody);
 if (!remainder || remainder.stores.length !== 1 || !same(remainder.stores[0].array, array) ||
     !same(remainder.stores[0].index, tailBase) || !same(remainder.stores[0].value, constant(0)) ||
     !same(tailBody.get(index), offset(tailBase, 1)) || !same(tailBody.get(bound), threshold[1]) ||
     [...remainder.inputs].some(slot => slot !== index &&
       !same(tailBody.get(slot), tailEntry.get(slot)))) return null;
 return {width, dims:dims.map(f => f[1]), array:array[1]};
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
 if(readiness!==null)guards.push(...c.readinessSeq(readiness),OP.i32_and);
 const out=[...guards,OP.if,0x40,...calls(),OP.i32_mul,...set(n),
  ...get(n),...iconst(0),OP.i32_ge_s,...get(n),...iconst(1048576),OP.i32_le_s,OP.i32_and,OP.if,0x40,
  ...get(n),...iconst(plan.width),OP.i32_div_s,...get(n),...iconst(plan.width),OP.i32_rem_s,OP.i32_add,...iconst(2),OP.i32_add,...set(cost),
  ...get(c.fuelLocal),...get(cost),OP.i32_gt_s,OP.if,0x40,
  ...get(n),OP.i32_eqz,OP.if,0x40,...get(c.fuelLocal),...get(cost),OP.i32_sub,...set(c.fuelLocal),...iconst(-1),STRUCTURED_RETURN,OP.end,
  OP.call,...uleb(array.idx),...set(arrayLocal),
  ...get(arrayLocal),OP.call,...uleb(kind),OP.if,0x40,
  ...get(arrayLocal),OP.call,...uleb(c.abaseIdx),...set(base),
  ...get(arrayLocal),OP.call,...uleb(c.alen0Idx),...set(length),
  ...get(length),...get(n),OP.i32_ge_u,OP.if,0x40,
  ...get(base),...iconst(0),...get(n),...iconst(2),OP.i32_shl,0xfc,0x0b,0x00,
  ...get(c.fuelLocal),...get(cost),OP.i32_sub,...set(c.fuelLocal),...get(n),OP.call,...uleb(count),...iconst(-1),STRUCTURED_RETURN,
  OP.end,OP.end,OP.end,OP.end,OP.end];
 c.intZeroClearEntryBytes=out.length;c.intZeroClearEntryUnroll=plan.width;c.usedHeap=true;
 return out;
}
module.exports={recognizeIntZeroClear,emitIntZeroClearEntry};

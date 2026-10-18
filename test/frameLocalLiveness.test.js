'use strict';
const test=require('tape');
const {frameLocalLiveness:analyze}=require('../src/analysis/frameLocalLiveness');
const item=(label,instruction)=>({labelDef:label+':',instruction});
test('frame liveness follows loops, switches, definitions and exception successors',t=>{
 const code={codeItems:[
  item('entry','iload_0'),item('test',{op:'ifeq',arg:'end'}),
  item('read','iload_2'),item('store','istore_3'),item('inc',{op:'iinc',varnum:0,incr:-1}),
  item('back',{op:'goto',arg:'entry'}),item('end','iload_3'),item('return','ireturn'),
  item('handler',{op:'astore',arg:4}),item('catchRead',{op:'iload',arg:5}),item('catchReturn','ireturn')],
  exceptionTable:[{startLbl:'read',endLbl:'back',handlerLbl:'handler'}]};
 const a=analyze(code);t.ok(a,'label-only exception table resolves');
 for(const slot of [0,2,3,5])t.ok(a.has(0,slot),'entry keeps live slot '+slot);
 t.notOk(a.has(0,1),'unread slot is dead');t.notOk(a.has(0,4),'handler overwrites its exception slot');
 t.notOk(a.has(3,3),'ordinary store kills prior value');t.ok(a.has(3,5),'protected store conservatively retains handler dependency');
 t.ok(a.has(4,0),'iinc reads its preceding value');t.ok(a.has(6,3),'return reads current value');t.notOk(a.has(6,5),'outside protected range handler dependency dies');
 t.ok(a.has(-1,100),'unmapped resume point preserves all locals');t.ok(a.has(999,100),'out-of-range resume point preserves all locals');
 const numeric={codeItems:code.codeItems.map((x,i)=>({...x,pc:i*2})),exceptionTable:[{start_pc:4,end_pc:10,handler_pc:16}]};
 const b=analyze(numeric);t.ok(b,'numeric exception table resolves');for(let i=0;i<code.codeItems.length;i++)for(let slot=0;slot<6;slot++)t.equal(b.has(i,slot),a.has(i,slot),'numeric and label edges agree '+i+':'+slot);
 const sparse={codeItems:[item('load','iload_0'),item('select',{op:'lookupswitch',arg:{pairs:[[1,'one'],[2,'two']],defaultLabel:'other'}}),item('one','iload_1'),item('oneReturn','ireturn'),item('two','iload_2'),item('twoReturn','ireturn'),item('other','iload_3'),item('otherReturn','ireturn')]};
 const c=analyze(sparse);t.ok(c,'lookup switch resolves');for(const slot of [0,1,2,3])t.ok(c.has(0,slot),'all switch arms keep slot '+slot);
 const dense={codeItems:[...sparse.codeItems]};dense.codeItems[1]=item('select',{op:'tableswitch',low:1,labels:['one','two'],defaultLbl:'other'});
 const d=analyze(dense);t.ok(d,'table switch resolves');for(const slot of [0,1,2,3])t.ok(d.has(0,slot),'all table arms keep slot '+slot);
 t.end();
});
test('frame liveness tracks wide slots and refuses incomplete inputs and excessive work',t=>{
 const wide={codeItems:[item('start',{op:'lload',varnum:35}),item('write',{op:'lstore',arg:40}),item('load',{op:'dload',arg:70}),item('end','dreturn')]};
 const a=analyze(wide);t.ok(a,'explicit local operands resolve');for(const slot of [35,36,70,71])t.ok(a.has(0,slot),'wide read keeps slot '+slot);
 t.notOk(a.has(0,40),'wide destination old value dies');t.notOk(a.has(0,41),'wide destination second old slot dies');
 const alias={codeItems:[item('s','lload_0'),item('store','istore_1'),item('again','iload_0'),item('r','ireturn')]};
 const b=analyze(alias);t.ok(b.has(1,0),'overlapping write leaves live first slot');t.notOk(b.has(1,1),'overlapping narrow write kills its own old slot');
 const labelOnly={codeItems:[item('L0','iload_0'),item('L1','ireturn'),{labelDef:'handler:'},item('caught','astore_1'),item('read','iload_2'),item('return','ireturn')],exceptionTable:[{startLbl:'L0',endLbl:'L1',handlerLbl:'handler'}]};
 t.ok(analyze(labelOnly)?.has(0,2),'handler label without instruction still preserves reads');
 for(const instruction of [{op:'goto',arg:'missing'},{op:'ifeq',arg:'missing'},{op:'jsr',arg:'end'},{op:'ret',arg:0},{op:'wide',arg:{op:'iload',varnum:300}},{op:'iload',arg:-1},{op:'iload',arg:1024},'iload_5','unknown_opcode'])
  t.equal(analyze({codeItems:[item('s',instruction),item('end','return')]}),null,'unsupported input refuses '+JSON.stringify(instruction));
 for(const entry of [{startLbl:'missing',endLbl:'L1',handlerLbl:'handler'},{startLbl:'L0',endLbl:'L1',handler_pc:123},{startLbl:'L1',endLbl:'L0',handlerLbl:'handler'},{startLbl:'L0',start_pc:1,endLbl:'L1',handlerLbl:'handler'}])
  t.equal(analyze({...labelOnly,exceptionTable:[entry]}),null,'incomplete or conflicting exception regions refuse');
 t.equal(analyze({codeItems:Array.from({length:4097},()=>({instruction:'return'}))}),null,'instruction budget is bounded');
 t.equal(analyze({codeItems:[{labelDef:{opaque:true},instruction:'return'}]}),null,'opaque labels cannot resolve missing branches');
 t.equal(analyze({codeItems:[{pc:-1,instruction:'return'}]}),null,'invalid bytecode PC refuses');
 t.equal(analyze({codeItems:[item('s','iload_0')]}),null,'off-end fallthrough is not a complete graph');
 t.equal(analyze({codeItems:[item('s',{op:'ifeq',arg:'s'})]}),null,'conditional off-end fallthrough refuses');
 const big=Array.from({length:3000},(_,i)=>({instruction:{op:'iload',arg:1023}}));big.push({instruction:'return'});
 t.equal(analyze({codeItems:big}),null,'bitset storage budget is bounded');t.end();
});

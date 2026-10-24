'use strict';
const test=require('tape');
const {analyzeIntTreePrefix:analyze}=require('../src/jit/intTreePrefixPlan');

function fixture(){
 const values=[],state={stateful:true,instanceReads:new Map(),reads:new Map(),scalarSites:new Map()};
 const node=(op,args=[],imm=null,kind='I')=>{const n={id:values.length,op,args,imm,kind};values.push(n);return n;};
 const c=n=>node(n<0?'iconst_m1':n<=5?'iconst_'+n:'bipush',[],n<=5?null:String(n));
 const receiver=node('param',[],{index:0},'A'),zero=c(0),index=node('phi'),oldBit=node('phi'),undef=node('undef');
 const tree=()=>{const n=node('getfield',[receiver],['Field','Container',['links','[I']],'A');
  state.instanceReads.set(n.id,{array:{},receiver,slot:{key:'Container.links'}});return n;};
 const headerTree=tree(),headRead=node('iaload',[headerTree,index]);
 const read=(address,name)=>{const n=node('getstatic',[],['Field','Source',[name,'I']]);state.scalarSites.set(n.id,{native:{address},write:false});return n;};
 const write=(address,name,value)=>{const n=node('putstatic',[value],['Field','Source',[name,'I']],'V');state.scalarSites.set(n.id,{native:{address},write:true});return n;};
 const first=values.length,bytes=node('getstatic',[],['Field','Source',['input','[B']],'A');state.reads.set(bytes.id,{native:{address:96}});
 const pos=read(64,'offset'),byte=node('baload',[bytes,pos]),bit=read(80,'shift'),shift=node('ishr',[byte,bit]),one=c(1),value=node('iand',[shift,one]);
 const old=read(80,'shift'),delta=c(1),advanced=node('iadd',[old,delta]);write(80,'shift',advanced);
 const p=read(64,'offset'),b=read(80,'shift'),three=c(3),move=node('ishr',[b,three]),moved=node('iadd',[p,move]);write(64,'offset',moved);
 const b2=read(80,'shift'),seven=c(7),masked=node('iand',[b2,seven]);write(80,'shift',masked);
 const bitBody=values.slice(first),pointerTree=tree(),pointer=node('iaload',[pointerTree,index]),incOne=c(1),increment=node('iadd',[index,incOne]);
 const merged=node('phi',[pointer,increment]);index.args=[zero,merged];oldBit.args=[undef,value];
 const block=(id,predIds,phis,body,term)=>({id,predIds,phis,body,term});
 const jump=target=>({kind:'goto',target,args:[]});
 const blocks=[block(0,[],[],[zero],jump(1)),
  block(1,[0,6],[index,oldBit],[headerTree,headRead],{kind:'cond',insnOp:'iflt',args:[headRead],taken:7,fall:2}),
  block(2,[1],[],bitBody,jump(3)),
  block(3,[2],[],[],{kind:'cond',insnOp:'ifeq',args:[value],taken:5,fall:4}),
  block(4,[3],[],[pointerTree,pointer],jump(6)),block(5,[3],[],[incOne,increment],jump(6)),
  block(6,[4,5],[merged],[],jump(1)),block(7,[1],[],[],{kind:'return',insnOp:'ireturn',args:[index]})];
 return {fn:{values,blocks},state,node,c,receiver,index,oldBit,headerTree,headRead,bytes,pos,byte,bit,value,delta,merged};
}

test('integer tree prefix plan matches symbolic fields and complete branch structure',t=>{
 const f=fixture(),plan=analyze(f.fn,f.state);
 t.ok(plan,'canonical source-independent form recognized');
 t.deepEqual(plan.loopBlocks,[1,2,3,4,5,6],'complete iteration is certified');
 t.equal(plan.byteAddress,64,'byte cursor role inferred');t.equal(plan.bitAddress,80,'bit cursor role inferred');
 t.equal(plan.inputAddress,96,'byte input inferred');t.equal(plan.indexPhi,f.index.id,'loop traversal identity inferred');
 t.deepEqual(plan.bitPhis,[f.oldBit.id],'complete loop-carried bit state is retained');
 const inverted=fixture();Object.assign(inverted.fn.blocks[1].term,{insnOp:'ifge',taken:2,fall:7});
 Object.assign(inverted.fn.blocks[3].term,{insnOp:'ifne',taken:4,fall:5});
 t.ok(analyze(inverted.fn,inverted.state),'equivalent inverted conditions accepted');
 const renamed=fixture();for(const n of renamed.fn.values)if(n.imm?.[0]==='Field'){
  n.imm[1]='ArbitraryOwner';n.imm[2][0]='x_'+n.imm[2][0];
 }
 t.ok(analyze(renamed.fn,renamed.state),'neither class nor field spelling selects the optimization');
 const copied=fixture(),copy=copied.node('phi',[copied.index,copied.value]);copied.fn.blocks[1].phis.push(copy);
 t.deepEqual(analyze(copied.fn,copied.state).bitPhis,[copied.oldBit.id,copy.id],'every copy of the last-bit recurrence is retained');
 t.end();
});

test('prefix plan refuses additional faults, effects and unsupported cursor transforms',t=>{
 const changes=[
  f=>{f.state.stateful=false;},f=>{f.state.regions=true;},
  f=>{f.delta.op='iconst_2';},f=>{f.bit.imm[2][1]='Z';},
  f=>{f.fn.blocks[3].term.taken=4;f.fn.blocks[3].term.fall=5;},
  f=>{f.fn.blocks[4].term.target=7;},f=>{f.fn.blocks[2].predIds.push(0);},
  f=>{f.fn.blocks[2].body.push(f.node('invokestatic',[],['Method','Unknown',['call','()V']],'V'));},
  f=>{const n=f.node('baload',[f.bytes,f.pos]);f.fn.blocks[2].body.push(n);},
  f=>{const amount=f.c(100),index=f.node('iadd',[f.pos,amount]),load=f.node('baload',[f.bytes,index]);f.fn.blocks[2].body.push(amount,index,load);},
  f=>{const val=f.c(0),store=f.node('putstatic',[val],['Field','Source',['extra','I']],'V');
   f.state.scalarSites.set(store.id,{native:{address:112},write:true});f.fn.blocks[2].body.push(val,store);},
  f=>{const wrong=f.node('phi',[f.value,f.index]);f.fn.blocks[1].phis.push(wrong);},
 ];
 for(const [i,change]of changes.entries()){const f=fixture();change(f);t.equal(analyze(f.fn,f.state),null,'unsafe/unsupported shape '+i+' refuses');}
 t.end();
});

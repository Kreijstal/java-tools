"use strict";
const {parseDescriptor} = require('../parsing/typeParser');

function op(ins) { return typeof ins === 'string' ? ins.split(/\s+/)[0] : ins?.op; }
function localSlot(ins) {
  const name=op(ins), short=/_([0-3])$/.exec(name||'');
  if(short)return Number(short[1]);
  if(name==='iinc')return Number(ins.varnum ?? (Array.isArray(ins.arg)?ins.arg[0]:ins.arg));
  return Number(ins?.arg);
}
function literal(ins) {
  const name=op(ins);
  if(name==='iconst_m1')return -1;
  if(/^iconst_[0-5]$/.test(name||''))return Number(name.slice(-1));
  if(['bipush','sipush','ldc','ldc_w'].includes(name)){
    const value=Number(ins?.arg?.value ?? ins?.arg);
    if(Number.isInteger(value)&&value>=-2147483648&&value<=2147483647)return value;
  }
  return null;
}
// Guarded facts describe immutable integer arguments. Only direct comparisons
// are folded; the original instruction indices and handler PCs stay intact.
function pruneArgumentRanges(method,items,cfg,requested) {
  const facts=new Map(),targets=new Map(),used=new Set();
  if(!requested)return {guards:[],targets};
  const params=parseDescriptor(method.descriptor).params;
  let slot=(method.flags||[]).includes('static')?0:1;
  for(const type of params){
    const range=requested[slot];
    if(['boolean','byte','char','short','int'].includes(type)&&Array.isArray(range)&&
      range.length===2&&range.every(Number.isInteger)&&range[0]<=range[1]&&
      range[0]>=-2147483648&&range[1]<=2147483647){
      const written=items.some(({instruction:ins})=>{
        const name=op(ins);
        if(name==='wide')return true;
        if(!/^[ilfda]store(?:_[0-3])?$/.test(name||'')&&name!=='iinc')return false;
        const at=localSlot(ins);
        // Unknown encodings cannot establish immutability. Wide stores also
        // invalidate the adjacent JVM local slot.
        return !Number.isInteger(at)||at===slot||(/^[ld]store/.test(name)&&at+1===slot);
      });
      if(!written)facts.set(slot,{slot,min:range[0],max:range[1]});
    }
    slot+=type==='long'||type==='double'?2:1;
  }
  const operand=ins=>{
    if(/^iload(?:_[0-3])?$/.test(op(ins)||''))return facts.get(localSlot(ins))||null;
    const value=literal(ins);return value===null?null:{min:value,max:value};
  };
  const decide=(cmp,a,b)=>{
    switch(cmp){
      case 'eq':if(a.max<b.min||b.max<a.min)return false;if(a.min===a.max&&b.min===b.max&&a.min===b.min)return true;break;
      case 'ne':{const same=decide('eq',a,b);return same===null?null:!same;}
      case 'lt':if(a.max<b.min)return true;if(a.min>=b.max)return false;break;
      case 'ge':{const less=decide('lt',a,b);return less===null?null:!less;}
      case 'gt':return decide('lt',b,a);
      case 'le':return decide('ge',b,a);
    }
    return null;
  };
  for(const block of cfg.blocks){
    const indexes=block.insns,term=cfg.term[block.id];if(term?.kind!=='cond')continue;
    const index=indexes.at(-1),name=op(items[index]?.instruction);
    let a,b,cmp;
    if(/^if_icmp(eq|ne|lt|ge|gt|le)$/.test(name||'')&&indexes.length>=3){
      a=operand(items[indexes.at(-3)]?.instruction);b=operand(items[indexes.at(-2)]?.instruction);cmp=name.slice(7);
    }else if(/^if(eq|ne|lt|ge|gt|le)$/.test(name||'')&&indexes.length>=2){
      a=operand(items[indexes.at(-2)]?.instruction);b={min:0,max:0};cmp=name.slice(2);
    }
    if(!a||!b||a.slot===undefined&&b.slot===undefined)continue;
    const take=decide(cmp,a,b);if(take===null)continue;
    const target=take?term.taken:term.fall;
    cfg.term[block.id]={kind:'goto',target};targets.set(index,target);
    if(a.slot!==undefined)used.add(a.slot);if(b.slot!==undefined)used.add(b.slot);
  }
  return {guards:[...used].map(slot=>facts.get(slot)),targets};
}
module.exports={pruneArgumentRanges};

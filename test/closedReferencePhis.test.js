'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {ClosedCompiler} = require('../src/jit/closed/ClosedCompiler');
const {ModuleBuilder,VT,OP,refNull,structType} = require('../src/jit/closed/wasmBuilder');

const world = {
  reprOfDescriptor: descriptor => descriptor === 'LItem;' ? 'obj:Item' : 'any',
  reprJoin: (a,b) => a === b ? a : 'any',
  reprSubtype: (a,b) => a === b || a === 'null' || b === 'any',
  wasmType: (kind,repr) => repr === 'obj:Item' ? refNull('item:0') : [VT.anyref],
};
function value(id,op,kind='A') {return {id,op,kind,args:[],uses:[{}]};}
function compiler(values,join) {
  const fn={values,params:[],blocks:[{phis:[join],predIds:['typed','other']}]};
  const c=new ClosedCompiler(world,{fn,plan:new Map(),paramKinds:[],isStatic:true});
  c.inferReprs();return c;
}
function runOtherEdge(c,join) {
  const code=[...c.edgeCopies('other',0),...c.use(join,'A'),OP.ref_is_null];
  const builder=new ModuleBuilder();builder.addRecGroup('item',[structType([])]);
  builder.declareFunction('copy',[],[VT.i32]);builder.defineFunction('copy',c.locals,code);builder.exportFunction('copy','copy');
  const bytes=builder.build();assert.equal(WebAssembly.validate(bytes),true,'typed incoming copy is valid Wasm');
  return new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports.copy();
}

test('unseeded reference phi cycles widen dependent joins before local types are emitted',()=>{
  for(const reverse of [false,true]) {
    const a=value(1,'phi'),b=value(2,'phi'),empty=value(3,'undef',null),seed=value(4,'new'),join=value(5,'phi');
    seed.imm='Item';a.args=[empty,b];b.args=[a,a];join.args=[seed,b];
    const values=[a,b,empty,seed,join];if(reverse)values.reverse();
    const c=compiler(values,join);
    assert.equal(c.reprOf(a),'any');assert.equal(c.reprOf(b),'any');assert.equal(c.reprOf(join),'any');
    assert.equal(runOtherEdge(c,join),1,'undefined incoming storage retains its null default');
  }
});

test('null-only reference phi copies retain the bottom reference type at a typed join',()=>{
  const nil=value(1,'aconst_null'),loop=value(2,'phi'),seed=value(3,'new'),join=value(4,'phi');
  seed.imm='Item';loop.args=[nil,loop];join.args=[seed,loop];
  const c=compiler([join,loop,seed,nil],join);
  assert.equal(c.reprOf(loop),'null');assert.equal(c.reprOf(join),'obj:Item');
  assert.equal(runOtherEdge(c,join),1,'null can flow into the typed local without a runtime cast');
});

test('a reference loop with a concrete seed retains its inferred representation',()=>{
  const seed=value(1,'new'),a=value(2,'phi'),b=value(3,'phi');seed.imm='Item';a.args=[seed,b];b.args=[a,a];
  const c=compiler([b,a,seed],a);
  assert.equal(c.reprOf(seed),'obj:Item');assert.equal(c.reprOf(a),'obj:Item');assert.equal(c.reprOf(b),'obj:Item');
});

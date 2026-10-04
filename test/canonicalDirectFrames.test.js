"use strict";
const test=require('tape');
const {CanonicalDirectLinks,DirectFrameContext}=require('../src/jit/CanonicalDirectFrames');
const {T,OP,uleb,sleb,assembleModule}=require('../src/jit/wasmShared');
const Frame=require('../src/core/frame');
function raw(fn){
 const bytes=assembleModule({importDecls:[{name:'value',params:[T.i32],results:[T.i32]}],
  mainParams:[T.i32],mainResults:[T.i32,T.i32,T.ref,T.i32],declared:[],
  body:[OP.i32_const,...sleb(-1),OP.i32_const,1,OP.ref_null,T.ref,OP.local_get,0,OP.call,0,OP.end]});
 return new WebAssembly.Instance(new WebAssembly.Module(bytes),{env:{value:fn}}).exports.run;
}
test('canonical direct table changes targets without changing the fallback contract',t=>{
 const links=new CanonicalDirectLinks(),calls=[];
 const fallback=x=>{calls.push(x);return x+7;};
 const slot=links.allocate('C.f(I)I',[T.i32],[T.i32],fallback);
 t.deepEqual(links.table.get(slot)(3),[-6,0,null,10],'unpublished target calls the existing bridge exactly once');
 const st={key:'C.f(I)I',status:'ready',meta:{canonicalRun:raw(x=>x+20),normalFlowFullyCompiled:true,
  usedEh:true,retChar:'I',paramSlots:[{slot:0,t:T.i32}]}};
 st.callee={meta:{paramSlots:[{slot:0,t:T.i32},{slot:1,t:T.i32}]}};
 links.publish(st);
 t.deepEqual(links.table.get(slot)(3),[-1,1,null,23],'publication actually replaces the native table target');
 t.deepEqual(calls,[3],'native call never invokes the bridge');
 for(const change of [{usedEh:false},{boxedCount:1},{normalFlowFullyCompiled:false},
  {speculations:1},{specSites:[{}]},{retChar:'L'},{frameEntryOnly:true},
  {paramSlots:[{slot:1,t:T.i32}]}]){
  links.publish({...st,meta:{...st.meta,...change}});
  t.deepEqual(links.table.get(slot)(5),[-6,0,null,12],'fallback remains available for '+Object.keys(change)[0]);
 }
 links.publish(st);links.withdraw(st.key);
 t.deepEqual(links.table.get(slot)(6),[-6,0,null,13],'withdrawal immediately restores the canonical bridge');
 links.release([slot]);t.equal(links.table.get(slot),null,'released slots retain no target');
 t.equal(links.allocate('D.f(I)I',[T.i32],[T.i32],fallback),slot,'failed or retired translations reuse table storage');
 t.equal(links.table.length,1,'table does not grow when released slots are reused');
 t.end();
});
test('deferred direct frames preserve separate recursive exits and transfer ownership',t=>{
 const method={name:'f',descriptor:'(I)I',flags:['static'],attributes:[{type:'code',code:{localsSize:'3',codeItems:[]}}]};
 const current=new Frame(method),box={frame:current,pendingFrames:null};
 const ctx=new DirectFrameContext({},method,'C',box);
 t.equal(ctx.frame(0),current,'ordinary JS entry still owns its original frame');
 t.equal(ctx.createdFrames,0,'ordinary entry allocates no deferred frame');
 const outer=ctx.frame(7),inner=ctx.frame(8);
 outer.locals[0]=12;inner.locals[0]=19;
 ctx.exit(8,24);t.equal(ctx.take(8),inner,'inner invocation transfers its own frame');
 t.equal(inner.pc,24,'inner resume PC is preserved');
 const children=[inner];box.pendingFrames=children;
 ctx.exit(7,42);t.equal(ctx.take(7),outer,'outer invocation transfers its independent frame');
 t.equal(outer.locals[0],12,'recursive spills cannot overwrite the outer values');
 t.equal(outer.wasmDirectPendingFrames,children,'deeper handoff order is retained');
 t.equal(box.pendingFrames,null,'transferred children are released from shared scratch');
 const thrown={type:'java/lang/RuntimeException'};box.pendingException=thrown;box.throwPc=91;
 const eh=ctx.frame(9);eh.pc=17;ctx.exit(9,-3);
 t.equal(eh.pc,17,'exception exit preserves the exact spill PC');
 t.equal(eh.wasmDirectException,thrown,'exception belongs to the exiting invocation');
 t.equal(eh.wasmDirectThrowPc,91,'handler matching retains original bytecode PC');
 t.equal(box.pendingException,null,'shared exception scratch no longer owns the value');
 ctx.take(9);t.equal(ctx.frames.size,0,'taken frames are never kept for reuse while scheduler-owned');
 t.throws(()=>ctx.take(9),/without a canonical spill/,'a missing exit cannot publish a fabricated frame');
 t.end();
});


test('nonthrowing scalar exports publish without a live exception site',t=>{
 const links=new CanonicalDirectLinks(),calls=[];
 const slot=links.allocate('Scalar.mask(II)I',[T.i32],[T.i32],x=>{calls.push(x);return x+7;});
 const st={key:'Scalar.mask(II)I',status:'ready',meta:{canonicalRun:raw(x=>x&7),
  normalFlowFullyCompiled:true,usedEh:false,canonicalNonThrowingNormalFlow:true,
  retChar:'I',paramSlots:[{slot:0,t:T.i32}]}};
 links.publish(st);
 t.deepEqual(links.table.get(slot)(11),[-1,1,null,3],'proved scalar export replaces its late-bound fallback');
 t.deepEqual(calls,[],'productive scalar call never enters JavaScript fallback');
 for(const change of [{canonicalNonThrowingNormalFlow:false},{normalFlowFullyCompiled:false},
  {boxedCount:1},{speculations:1},{specSites:[{}]},{retChar:'L'},
  {frameEntryOnly:true},{paramSlots:[{slot:1,t:T.i32}]}]){
  links.publish({...st,meta:{...st.meta,...change}});
  t.deepEqual(links.table.get(slot)(5),[-6,0,null,12],'unproved scalar falls back: '+Object.keys(change)[0]);
 }
 links.publish(st);links.withdraw(st.key);
 t.deepEqual(links.table.get(slot)(6),[-6,0,null,13],'withdrawal retires the scalar export immediately');
 links.release([slot]);t.end();
});


test('recorded handler-free exports keep all other publication guards',t=>{
 const links=new CanonicalDirectLinks(),calls=[];
 const slot=links.allocate('Leaf.read(I)I',[T.i32],[T.i32],x=>{calls.push(x);return x+7;});
 const st={key:'Leaf.read(I)I',status:'ready',meta:{canonicalRun:raw(x=>x+11),
  normalFlowFullyCompiled:true,usedEh:false,canonicalRecordedNormalFlow:true,
  retChar:'I',paramSlots:[{slot:0,t:T.i32}]}};
 links.publish(st);
 t.deepEqual(links.table.get(slot)(3),[-1,1,null,14],'recorded leaf replaces the fallback');
 t.deepEqual(calls,[],'normal return crosses no JavaScript fallback');
 for(const change of [{canonicalRecordedNormalFlow:false},{normalFlowFullyCompiled:false},
  {boxedCount:1},{speculations:1},{specSites:[{}]},{retChar:'L'},{frameEntryOnly:true},
  {paramSlots:[{slot:1,t:T.i32}]}]){
  links.publish({...st,meta:{...st.meta,...change}});
  t.deepEqual(links.table.get(slot)(5),[-6,0,null,12],'unsafe shape keeps fallback: '+Object.keys(change)[0]);
 }
 links.publish(st);links.withdraw(st.key);
 t.deepEqual(links.table.get(slot)(6),[-6,0,null,13],'withdrawal retires the recorded export');
 links.release([slot]);t.end();
});

test('canonical leaf imports retain throw identity and count recorded calls',t=>{
 const Compiler=require('../src/jit/StructuredWasmCompiler');
 const marker=Error('canonical-leaf-import');
 const reg={importIndexByName:new Map(),importDecls:[],importFns:[],box:{},
  wasmJit:{importStatsEnabled:true,canonicalDirectCallsEnabled:true},canonicalRecordedLeaf:true};
 Compiler.prototype.addImport.call(reg,'boom',[T.i32],[],()=>{throw marker;});
 let thrown;try{reg.importFns[0](3);}catch(e){thrown=e;}
 t.equal(thrown,marker,'host error identity survives the recording import');
 t.equal(reg.box.lastThrown,marker,'canonical wrapper has the exact thrown object');
 t.equal(reg.box.pendingException,null,'host errors do not become Java exceptions');
 t.equal(reg.importStats.get('boom'),1,'EH recording preserves import counters');
 const guest={type:'java/lang/ArrayIndexOutOfBoundsException'};
 Compiler.prototype.addImport.call(reg,'guest',[],[],()=>{throw guest;});
 try{reg.importFns[1]();}catch(e){thrown=e;}
 t.equal(thrown,guest,'guest exception identity survives recording');
 t.equal(reg.box.pendingException,guest,'guest classification is retained');
 t.end();
});

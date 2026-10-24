'use strict';
const test=require('tape');
const {T,OP,CAPTURE_DIRECT_ID,STRUCTURED_RETURN,CLOSED_NATIVE_ENTRY,entryModeCode,assembleModule}=require('../src/jit/wasmShared');
const {getNativeObjectStorageOps,nativeObjectStorageTypes}=require('../src/core/nativeObjectStorage');

test('fixed canonical entries select their protocol while the shared core retains both modes',t=>{
 if(!getNativeObjectStorageOps()){t.pass('requires Wasm GC');t.end();return;}
 for(const padding of [0,18000]){
  let ordinary=0,closed=0,ready=true;
  const bytes=assembleModule({
   importDecls:[{name:'ready',params:[],results:[T.i32]},
    {name:'ordinary',params:[],results:[T.i32]},{name:'closed',params:[],results:[T.i32]}],
   mainParams:[T.ref,[0x63,1],T.i32,T.i32],mainResults:[T.i32],declared:[T.i32],
   gcTypes:nativeObjectStorageTypes(),parameterObjectABI:[0],retvType:T.i32,runvWrapper:true,
   canonicalFrameExport:{readyIdx:0,compact:true,inlineCompact:true,closedStorage:true,idLocal:4},
   body:[CAPTURE_DIRECT_ID,...Array(padding).fill(0x01),
    entryModeCode(2,[OP.call,1,OP.global_set,0],[OP.call,2,OP.global_set,0]),
    OP.i32_const,0x7f,STRUCTURED_RETURN,OP.end]});
  const x=new WebAssembly.Instance(new WebAssembly.Module(bytes),{env:{ready:()=>+ready,
   ordinary:()=>{ordinary++;return 10;},closed:()=>{closed++;return 20;}}}).exports;
  const label=padding?'bounded-code wrapper':'inline body';
  t.equal(!!x.canonicalInlineCompactStorageRun,!padding,label+' uses the intended emission path');
  t.deepEqual(x.canonicalCompactStorageRun(null,null),[-1,10],label+' ordinary typed entry');
  t.deepEqual(x.canonicalClosedStorageRun(null,null),[-1,20],label+' dedicated closed entry');
  t.deepEqual([ordinary,closed],[1,1],label+' runs only its selected protocol');
  t.equal(x.run(null,0,100),-1,label+' shared core ordinary mode completes');
  t.equal(x.retv.value,10,label+' shared core retains ordinary recovery');
  t.equal(x.run(null,CLOSED_NATIVE_ENTRY,100),-1,label+' shared core accepts the private wrapper mode');
  t.equal(x.retv.value,20,label+' shared core retains closed recovery');
  ready=false;t.deepEqual(x.canonicalClosedStorageRun(null,null),[-4,0],label+' cold owner refuses before either protocol');
  t.deepEqual([ordinary,closed],[2,2],label+' cold refusal runs no protocol callbacks');
 }
 t.end();
});

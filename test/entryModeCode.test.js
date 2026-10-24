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

test('paired-storage entry is distinct from both untrusted and closed-body entry modes',t=>{
 const {PAIRED_STORAGE_ENTRY}=require('../src/jit/wasmShared');
 t.equal(PAIRED_STORAGE_ENTRY,-2,'paired storage has a separate private mode');
 for(const padding of [0,18000]){
  let ordinary=0,closed=0,paired=0,ready=true;
  const protocol=[entryModeCode(2,[OP.call,1,OP.global_set,0],[OP.call,2,OP.global_set,0],0x40,PAIRED_STORAGE_ENTRY)];
  const bytes=assembleModule({importDecls:[{name:'ready',params:[],results:[T.i32]},
    {name:'ordinary',params:[],results:[T.i32]},{name:'paired',params:[],results:[T.i32]},{name:'closed',params:[],results:[T.i32]}],
   mainParams:[T.ref,[0x63,1],T.i32,T.i32],mainResults:[T.i32],declared:[T.i32],gcTypes:nativeObjectStorageTypes(),
   parameterObjectABI:[0],retvType:T.i32,runvWrapper:true,
   canonicalFrameExport:{readyIdx:0,compact:true,inlineCompact:true,pairedStorage:true,closedStorage:true,idLocal:4},
   body:[CAPTURE_DIRECT_ID,...Array(padding).fill(OP.nop??0x01),
    entryModeCode(2,protocol,[OP.call,3,OP.global_set,0]),OP.i32_const,0x7f,STRUCTURED_RETURN,OP.end]});
  t.ok(WebAssembly.validate(bytes),'both modes validate under '+(padding?'bounded wrapper':'inline code'));
  const x=new WebAssembly.Instance(new WebAssembly.Module(bytes),{env:{ready:()=>+ready,
   ordinary:()=>{ordinary++;return 10;},paired:()=>{paired++;return 30;},closed:()=>{closed++;return 20;}}}).exports;
  t.deepEqual(x.canonicalCompactStorageRun(null,null),[-1,10],'ordinary typed entry does not assume pairing');
  t.deepEqual(x.canonicalPairedStorageRun(null,null),[-1,30],'paired entry selects only its entry protocol');
  t.deepEqual(x.canonicalClosedStorageRun(null,null),[-1,20],'closed-body entry keeps its separate protocol');
  t.deepEqual([ordinary,closed,paired],[1,1,1],'fixed wrappers do not execute another mode callback');
  t.equal(x.run(null,PAIRED_STORAGE_ENTRY,100),-1,'shared core supports the paired private mode');
  t.equal(x.retv.value,30,'shared core paired return remains exact');
  const legacy=x.canonicalRun(null);
  t.equal(legacy[0],-1,'untrusted legacy export completes normally');
  t.equal(legacy[1],4,'paired entry participates in canonical invocation accounting');
  t.equal(legacy[2],x.canonicalOwner.value,'untrusted legacy entry retains its exact owner');
  t.equal(legacy[3],10,'untrusted legacy export retains its ordinary result');
  ready=false;t.deepEqual(x.canonicalPairedStorageRun(null,null),[-4,0],'cold paired owner refuses before protocol effects');
  t.deepEqual([ordinary,closed,paired],[2,1,2],'cold refusal does not execute either entry body');
 }
 t.end();
});

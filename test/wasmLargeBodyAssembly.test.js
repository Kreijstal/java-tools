'use strict';
const test=require('tape');
const {T,OP,CAPTURE_DIRECT_ID,STRUCTURED_RETURN,entryModeCode,assembleModule,
 emitTryTableCatchAll,emitTryTableJsTag,supportsWasmJsTag}=require('../src/jit/wasmShared');

test('large structured alternatives and compact candidates do not become function arguments',t=>{
 for(const tagged of [false,true]){
  if(tagged&&!supportsWasmJsTag())continue;
  const ordinary=Array(200000).fill(0x01);
  ordinary.push(OP.i32_const,7,OP.global_set,0,OP.call,tagged?2:1);
  const body=[CAPTURE_DIRECT_ID,entryModeCode(0,ordinary,[OP.i32_const,21,OP.global_set,0]),
   OP.i32_const,0x7f,STRUCTURED_RETURN,OP.end];
  const bytes=assembleModule({importJsTag:tagged,
   importDecls:[{name:'ready',params:[],results:[T.i32]},
    ...(tagged?[{name:'record',params:[T.ref],results:[]}]:[]),
    {name:'effect',params:[],results:[]}],
   mainParams:[T.i32,T.i32],mainResults:[T.i32],declared:[T.i32],retvType:T.i32,runvWrapper:true,
   canonicalFrameExport:{readyIdx:0,recordIdx:tagged?1:undefined,
    compact:true,inlineCompact:true,closedStorage:true,idLocal:2},body});
  let failure,recorded,hits=0;
  const marker={largeBody:true},x=new WebAssembly.Instance(new WebAssembly.Module(bytes),{env:{
   ...(tagged?{js_tag:WebAssembly.JSTag,record:e=>{recorded=e;}}:{}),
   ready:()=>1,effect:()=>{hits++;if(failure)throw marker;}}}).exports;
  t.notOk(x.canonicalInlineCompactRun,'oversized ordinary candidate keeps the bounded wrapper');
  t.deepEqual(x.canonicalCompactRun(),[-1,7],'large ordinary path completes exactly');
  t.deepEqual(x.canonicalClosedStorageRun(),[-1,21],'fixed closed entry selects the small alternative');
  t.equal(hits,1,'closed alternative does not execute the ordinary effect');
  failure=true;t.deepEqual(x.canonicalCompactRun(),[-5,7],'exception still takes the compact recovery path');
  t.equal(hits,2,'throwing effect executes once');
  if(tagged)t.equal(recorded,marker,'large tagged body preserves throwable identity');
 }
 t.end();
});

test('large exception handlers also avoid call argument limits',t=>{
 for(const tagged of [false,true]){
  if(tagged&&!supportsWasmJsTag())continue;
  const body=[],emit=tagged?emitTryTableJsTag:emitTryTableCatchAll;
  emit(body,out=>out.push(OP.call,0),out=>{
   for(let i=0;i<200000;i++)out.push(0x01);
   out.push(OP.call,2);
  },1);
  body.push(OP.end);
  let records=0,handled=0;
  const bytes=assembleModule({importJsTag:tagged,
   importDecls:[{name:'fail',params:[],results:[]},{name:'record',params:[T.ref],results:[]},
    {name:'handled',params:[],results:[]}],mainParams:[],mainResults:[],declared:[],body});
  const x=new WebAssembly.Instance(new WebAssembly.Module(bytes),{env:{
   ...(tagged?{js_tag:WebAssembly.JSTag}:{}),fail:()=>{throw 17;},
   record:e=>{t.equal(e,17,'original primitive exception reaches recorder');records++;},handled:()=>handled++}}).exports;
  x.run();t.equal(handled,1,'large handler executes once');t.equal(records,tagged?1:0,'only tagged handler records payload');
 }
 t.end();
});

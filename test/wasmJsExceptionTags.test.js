'use strict';
const test = require('tape');
const {T, OP, assembleModule, emitTryTableJsTag, supportsWasmJsTag} = require('../src/jit/wasmShared');

test('importing the JavaScript tag preserves function and indirect signature indices', t => {
  if (typeof WebAssembly.Tag !== 'function' || !WebAssembly.JSTag) {
    // A fresh externref tag verifies the assembler on engines without JSTag.
    if (typeof WebAssembly.Tag !== 'function') {t.pass('exception tags unavailable');t.end();return;}
  }
  const tag = WebAssembly.JSTag || new WebAssembly.Tag({parameters:['externref']});
  for (const extra of [{}, {importMemory:true}, {importTable:true}, {importCanonicalTable:true},
    {importMemory:true,importTable:true,importCanonicalTable:true}]) {
    const bytes = assembleModule({
      ...extra, importJsTag:true, sigTypes:[{params:[T.i32],results:[T.i32]}],
      importDecls:[{name:'identity',params:[T.i32],results:[T.i32]}],
      mainParams:[T.i32], mainResults:[T.i32], declared:[],
      body:[OP.local_get,0,OP.call,0,OP.end],
    });
    const module = new WebAssembly.Module(bytes);
    const env = {js_tag:tag,identity:v=>v+3};
    if (extra.importMemory) env.mem = new WebAssembly.Memory({initial:1});
    if (extra.importTable) env.ltab = new WebAssembly.Table({initial:0,element:'anyfunc'});
    if (extra.importCanonicalTable) env.ctab = new WebAssembly.Table({initial:0,element:'anyfunc'});
    const instance = new WebAssembly.Instance(module,{env});
    t.equal(instance.exports.run(11),14,'tag does not shift function target with '+JSON.stringify(extra));
    t.equal(WebAssembly.Module.imports(module).filter(i=>i.kind==='tag').length,1,'one separate tag import');
  }
  t.end();
});

test('native JavaScript tag capture preserves original thrown values', t => {
  const supported = supportsWasmJsTag();
  t.equal(supportsWasmJsTag(),supported,'capability probe is stable');
  if (!supported) {t.pass('unsupported engine retains the recording-import path');t.end();return;}
  const body=[];
  emitTryTableJsTag(body,out=>out.push(OP.call,0),()=>{},1);
  body.push(OP.end);
  const bytes=assembleModule({importJsTag:true,
    importDecls:[{name:'throw_js',params:[],results:[]},{name:'record_js',params:[T.ref],results:[]}],
    mainParams:[],mainResults:[],declared:[],body});
  let value,observed,hits=0;
  const instance=new WebAssembly.Instance(new WebAssembly.Module(bytes),{env:{
    js_tag:WebAssembly.JSTag,throw_js:()=>{throw value;},record_js:v=>{observed=v;hits++;}}});
  for (const thrown of [Error('marker'),{type:'java/lang/RuntimeException'},null,undefined,0,false,'marker']) {
    value=thrown;observed=Symbol();const before=hits;
    instance.exports.run();
    t.ok(Object.is(observed,thrown)&&hits===before+1,'exact payload is recorded once');
  }
  const foreign=new WebAssembly.Exception(new WebAssembly.Tag({parameters:['i32']}),[7]);
  value=foreign;const before=hits;
  t.throws(()=>instance.exports.run(),e=>e===foreign,'foreign tag propagates with original identity');
  t.equal(hits,before,'foreign tag does not call the JavaScript recorder');
  t.end();
});

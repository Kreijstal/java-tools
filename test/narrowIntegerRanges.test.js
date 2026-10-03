'use strict';
const test = require('tape');
const {maskedIntegerRange,narrowIntegerLoadRanges} = require('../src/jit/narrowIntegerRanges');
const {JVM} = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const CallStack = require('../src/core/callStack');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const fixture = makeJavaFixtureCompiler('narrow-integer-ranges-');

test('masked interval proof includes every allowed input', t => {
  for (const [minimum,maximum,excluded] of [
    [-128,127,[-1]],[-128,127,[]],[-128,511,[-1]],[-32768,32767,[-1]],
    [0,254,[]],[0,255,[255]],[-1,-1,[]],[-16,16,[-1,15]],
  ]) for (const mask of [0,1,7,15,31,127,255,511,65535]) {
    const input={minimum,maximum,excluded:new Set(excluded)}, range=maskedIntegerRange(mask,input);
    let sound=true;
    for(let value=minimum;value<=maximum;value++) if(!input.excluded.has(value)) {
      const actual=value&mask;
      if(actual<range.minimum||actual>range.maximum){sound=false;break;}
    }
    t.ok(sound,`mask ${mask} contains allowed values in [${minimum},${maximum}] excluding ${excluded}`);
  }
  t.equal(maskedIntegerRange(255,{minimum:-128,maximum:127,excluded:new Set([-1])}).maximum,254,
    'excluded signed byte sentinel tightens the mask');
  t.equal(maskedIntegerRange(255,{minimum:-2147483648,maximum:2147483647,excluded:new Set([-1])}).maximum,255,
    'excluding -1 from an arbitrary int does not exclude 255');
  t.end();
});

test('narrow facts decline synthetic or cloned control flow', t => {
  const items=[{instruction:{op:'baload'}},{instruction:{op:'istore',arg:0}},
    {instruction:{op:'iload',arg:0}}];
  const adapters={items,opOf:ins=>ins?.op,localIndex:ins=>ins.arg,integerConstant:()=>null};
  const cfg={entry:0,blocks:[{id:0,insns:[0,1,2]}],term:[{kind:'return'}],succ:[[]]};
  t.equal(narrowIntegerLoadRanges({...adapters,cfg}).get(2)?.maximum,127,'normal narrow definition is available');
  t.equal(narrowIntegerLoadRanges({...adapters,cfg:{...cfg,blocks:[{...cfg.blocks[0],synthetic:{}}]}}).size,0,
    'synthetic flow is declined');
  t.equal(narrowIntegerLoadRanges({...adapters,cfg:{...cfg,blocks:[...cfg.blocks,{id:1,insns:[2]}]}}).size,0,
    'cloned bytecode cannot overwrite another path snapshot');
  t.end();
});

test('palette loops preserve values and exceptions after branch refinement', async t => {
  const classpath=fixture(t,'NarrowPalette',`public class NarrowPalette {
    static int sum(byte[] input,int[] palette) {
      int result=0;for(int i=0;i<input.length;i++){int value=input[i];if(value!=-1)result+=palette[value&255];}return result;
    }
    static int overwrite(byte[] input,int[] palette) {
      int result=0;for(int i=0;i<input.length;i++){int value=input[i];if(value!=-1){value=255;result+=palette[value&255];}}return result;
    }
    static int decrement(byte[] input,int[] palette) {
      int result=0;for(int i=0;i<input.length;i++){int value=input[i];if(value!=-1){value--;result+=palette[value&255];}}return result;
    }
    static int joined(byte[] input,int[] palette,boolean replace) {
      int result=0;for(int i=0;i<input.length;i++){int value=input[i];if(replace)value=255;if(value!=-1)result+=palette[value&255];}return result;
    }
  }`);
  const j=new JVM({classpath,jit:{compileWorker:false,structuredSsa:true,compiledCallChains:true,
    ordinaryAdaptiveFramelessPositional:true,preferWholeMethodJs:true,retainCompilerDiagnostics:true}});
  await j.loadClassByName('NarrowPalette');j.classInitializationState.set('NarrowPalette','INITIALIZED');
  j.jit.effectfulPreparationActive=true;j._nextEventLoopYieldAt=Infinity;
  const prepared={};
  for(const name of ['sum','overwrite','decrement','joined']){
    const method=await j.findMethodInHierarchy('NarrowPalette',name,name==='joined'?'([B[IZ)I':'([B[I)I');
    const body=j.jit.getGeneratedFunction(method,{allowEffectfulCalls:true,compileLocally:true});
    t.ok(body,`${name} compiles`);prepared[name]={method,body};
  }
  const source=String(prepared.sum.body);
  t.ok(/254 < ssaEntryArrayData/.test(source),'generated palette proof accepts length 255');
  const invoke=(name,input,palette,replace=0)=>{
    const {method,body}=prepared[name],frame=new Frame(method);
    frame.className='NarrowPalette';frame.locals[0]=input;frame.locals[1]=palette;frame.locals[2]=replace;
    const thread={status:'runnable',callStack:new CallStack()};thread.callStack.push(frame);
    return body(frame,thread,j.jit,false).value;
  };
  const palette=Int32Array.from({length:255},(_,i)=>(i*7-123)|0);
  const input=Int8Array.from({length:256},(_,i)=>i-128);
  const expected=Array.from(input).reduce((sum,x)=>x===-1?sum:(sum+palette[x&255])|0,0);
  t.equal(invoke('sum',input,palette),expected,'all signed bytes produce exact palette sum');
  t.equal(invoke('sum',Int8Array.of(-1),new Int32Array(0)),0,'excluded sentinel does not access empty palette');
  for(const [name,args] of [
    ['sum',[Int8Array.of(-2),new Int32Array(254)]],
    ['overwrite',[Int8Array.of(1),palette]],
    ['decrement',[Int8Array.of(0),palette]],
    ['joined',[Int8Array.of(1),palette,1]],
  ]) {
    let error;try{invoke(name,...args);}catch(e){error=e;}
    t.equal(error?.type,'java/lang/ArrayIndexOutOfBoundsException',`${name} retains required bounds exception`);
  }
  t.equal(invoke('joined',input,palette,0),expected,'join without replacement retains exact execution');
  t.end();
});

test('narrow facts invalidate every supported or opaque local increment', t => {
  for (const increment of [
    {op:'iinc',varnum:0,increment:1}, {op:'iinc',arg:[0,1]},
    {op:'iinc',arg:'0 1'}, {op:'iinc',arg:{index:0,constant:1}},
    {op:'wide',arg:'iinc 0 1'}, {op:'wide',arg:'istore 0'},
  ]) {
    const items=[{instruction:{op:'baload'}},{instruction:{op:'istore',arg:0}},
      {instruction:increment},{instruction:{op:'iload',arg:0}}];
    const cfg={entry:0,blocks:[{id:0,insns:[0,1,2,3]}],term:[{kind:'return'}],succ:[[]]};
    const facts=narrowIntegerLoadRanges({cfg,items,opOf:ins=>ins?.op,
      localIndex:ins=>ins.arg,integerConstant:()=>null});
    t.notOk(facts.has(3),`${JSON.stringify(increment)} does not preserve the prior byte range`);
  }
  t.end();
});

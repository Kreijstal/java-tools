'use strict';
const test = require('tape');
const {JVM} = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const CallStack = require('../src/core/callStack');
const {PreparedCodeCache} = require('../src/jit/PreparedCodeCache');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const fixture = makeJavaFixtureCompiler('prepared-code-cache-');
const identity = {runtime:'test-runtime',source:'test-source',patch:'test-patch',configuration:'test-config'};

test('optional prepared cache reuses bounded entries and retains compilation fallbacks', async t => {
  const classpath = fixture(t,'CacheProbe',`public class CacheProbe {
    static int factor; static int calls;
    static int scale(int value) { calls++; return value * factor; }
    static int sum(int[] values) { int s=0; for(int i=0;i<values.length;i++) s+=scale(values[i]); return s; }
  }`);
  const create = async factor => {
    const j = new JVM({classpath,jit:{compileWorker:false,structuredSsa:true,
      compiledCallChains:true,ordinaryAdaptiveFramelessPositional:true,
      preferWholeMethodJs:true,retainCompilerDiagnostics:false}});
    await j.loadClassByName('CacheProbe');
    j.classInitializationState.set('CacheProbe','INITIALIZED');
    j.classes.CacheProbe.staticFields.set('factor:I',factor);
    j.classes.CacheProbe.staticFields.set('calls:I',0);
    return j;
  };
  const prepare = (j, config) => j.precompileInitializedClasses({
    effectful:true,fixedPoint:false,wasm:false,preparedCodeCache:config,
    preparationPolicy:{maxMethods:2,priorityMethods:['CacheProbe.scale(I)I','CacheProbe.sum([I)I']},
  });
  const invoke = async j => {
    const method = await j.findMethodInHierarchy('CacheProbe','sum','([I)I');
    const frame = new Frame(method);frame.className='CacheProbe';frame.locals[0]=[3,5,-2];
    const thread={status:'runnable',callStack:new CallStack()};thread.callStack.push(frame);
    j._nextEventLoopYieldAt=Infinity;
    const result=j.jit.codegenCache.get(method)(frame,thread,j.jit,false);
    t.equal(thread.callStack.size(),0,'execution retires its frame');
    return result.value;
  };
  const data = new Map(), operations=[];
  let active=0, peak=0;
  const operation = async (kind,key,fn) => {
    active++;peak=Math.max(peak,active);operations.push(kind+':'+JSON.parse(key)[1]);
    try {await Promise.resolve();return fn();} finally {active--;}
  };
  const store={get:(key,maxBytes)=>operation('get',key,()=>{
    const value=data.get(key);if(value && value.length*2>maxBytes)throw new Error('store read limit');return value;
  }),put:(key,value)=>operation('put',key,()=>data.set(key,value))};
  const source=await create(2), cold=await prepare(source,{identity,store});
  t.equal(cold.report.preparedCache.writes,2,'cold preparation persists both bodies');
  t.equal(data.size,2,'one stored entry per method');
  t.equal(peak,1,'storage has at most one operation in flight');
  t.deepEqual(operations.map(x=>x.split(':')[0]),['get','put','get','put'],
    'each entry is written before the next is read');
  t.equal(await invoke(source),12,'cold path computes correctly');
  const target=await create(3);
  let compiles=0;const compile=target.jit.compileMethod;
  target.jit.compileMethod=function(...args){compiles++;return compile.apply(this,args);};
  const restoredMethod=await target.findMethodInHierarchy('CacheProbe','sum','([I)I');
  target.jit.adaptiveCodegenSupportCache.set(restoredMethod,false);
  const warm=await prepare(target,{identity,store});
  t.equal(target.jit.getGeneratedFunction(restoredMethod),target.jit.codegenCache.get(restoredMethod),
    'restoration invalidates a stale admission rejection');
  t.equal(warm.report.preparedCache.hits,2,'warm preparation restores both entries');
  t.equal(compiles,0,'warm preparation performs no method compilation');
  t.equal(await invoke(target),18,'cached code binds receiver static state');
  t.equal(target.classes.CacheProbe.staticFields.get('calls:I'),3,'side effects occur once');
  t.ok(warm.report.preparedCache.peakPayloadBytes<=8*1024*1024,'payload accounting stays bounded');
  const shifted=await create(4);
  shifted.jit.registerFieldSite(['Field','CacheProbe',['factor','I']]);
  const shiftedReport=await prepare(shifted,{identity,store});
  t.equal(shiftedReport.report.preparedCache.hits,0,'different preparation position is a cache miss');
  t.equal(shiftedReport.report.preparedCache.refused,0,'later-round entries do not disable earlier-round replay');
  t.equal(shiftedReport.report.preparedCache.writes,2,'different preparation positions get their own entries');
  t.equal(data.size,4,'both preparation positions remain available');
  t.equal(await invoke(shifted),24,'shifted preparation position computes correctly');
  const first=[...data.values()][0];
  for(const kind of ['runtime','source','patch','configuration','watermark','oversized','read-error','write-error']){
    const j=await create(4);
    const entry=JSON.parse(first);
    if(Object.hasOwn(identity,kind))entry.identity[Object.keys(identity).indexOf(kind)]='wrong-identity';
    if(kind==='watermark')entry.before.fieldSites++;
    const broken={get:async()=>{
      if(kind==='read-error')throw new Error('read failed');
      if(kind==='write-error')return undefined;
      return kind==='oversized'?'x'.repeat(2048):JSON.stringify(entry);
    },put:async()=>{if(kind==='write-error')throw new Error('write failed');}};
    const report=await prepare(j,{identity,store:broken,...(kind==='oversized'?{maxEntryBytes:1024}:{})});
    t.equal(report.report.preparedCache.hits,0,`${kind} is never installed`);
    t.equal(await invoke(j),24,`${kind} falls back to ordinary compilation`);
    t.ok(report.report.preparedCache.refused+report.report.preparedCache.errors>0,`${kind} is reported`);
  }
  const tiny=await create(5), tinyReport=await prepare(tiny,{identity,store:{get:async()=>null,put:async()=>t.fail('over-budget write')},maxEntryBytes:0});
  t.equal(tinyReport.report.preparedCache.writes,0,'zero budget retains no cache payload');
  t.equal(await invoke(tiny),30,'zero budget preserves executable fallback');
  t.throws(()=>new PreparedCodeCache(tiny.jit,{identity:{...identity,runtime:''},store}),/runtime/,
    'incomplete identity is rejected');
  t.throws(()=>new PreparedCodeCache(tiny.jit,{identity,store,maxEntryBytes:-1}),/budget/,
    'invalid budget is rejected');
  t.end();
});

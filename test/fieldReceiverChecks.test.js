'use strict';
const test = require('tape');
const {JVM} = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const CallStack = require('../src/core/callStack');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const fixture = makeJavaFixtureCompiler('field-receiver-checks-');

test('block-local receiver proofs preserve null failures and changed references', async t => {
  const classpath = fixture(t,'FieldReceiverChecks',`public class FieldReceiverChecks {
    int x, y;
    static void touch(FieldReceiverChecks a) { a.y++; }
    static int aroundCall(FieldReceiverChecks a) { int x=a.x; touch(a); return x+a.y; }
    static int read(FieldReceiverChecks a) { return a.x + a.y + a.x; }
    static int replace(FieldReceiverChecks a, FieldReceiverChecks b) { int x=a.x; a=b; return x+a.y; }
    static int branch(FieldReceiverChecks a, FieldReceiverChecks b, boolean first) {
      int x=0; if(first) x=a.x; else x=b.x; return x+a.y;
    }
  }`);
  const observations = [];
  for (const cacheLimit of [undefined,0,8,9]) for (const enabled of [false,true]) {
    const j = new JVM({classpath,jit:{compileWorker:false,structuredSsa:true,
      preferWholeMethodJs:true,retainCompilerDiagnostics:true,
      structuredDominatedFieldReceiverChecks:enabled,
      structuredFieldReadCacheMaxCodeItems:cacheLimit}});
    await j.loadClassByName('FieldReceiverChecks');
    j.classInitializationState.set('FieldReceiverChecks','INITIALIZED');
    j.jit.effectfulPreparationActive=true; j._nextEventLoopYieldAt=Infinity;
    const aroundCall = await j.findMethodInHierarchy('FieldReceiverChecks','aroundCall','(LFieldReceiverChecks;)I');
    const callBody = j.jit.getGeneratedFunction(aroundCall,{allowEffectfulCalls:true,compileLocally:true});
    t.ok(callBody?.jvmStructuredSsa,'call-boundary fixture uses structured code');
    t.equal(callBody.jvmStructuredDominatedFieldReceiverCheckCount,0,
      'receiver proof is not retained across a call');
    const rows=[];
    for (const [name,descriptor,cases] of [
      ['read','(LFieldReceiverChecks;)I', [['a'],[null]]],
      ['replace','(LFieldReceiverChecks;LFieldReceiverChecks;)I', [['a','b'],['a',null]]],
      ['branch','(LFieldReceiverChecks;LFieldReceiverChecks;Z)I', [['a','b',1],[null,'b',0],['a',null,1]]],
    ]) {
      const method=await j.findMethodInHierarchy('FieldReceiverChecks',name,descriptor);
      const body=j.jit.getGeneratedFunction(method,{allowEffectfulCalls:true,compileLocally:true});
      t.ok(body?.jvmStructuredSsa,name+' uses structured code');
      if(name==='read') {
        t.equal(body.jvmStructuredDominatedFieldReceiverCheckCount,enabled?2:0,
          'only subsequent checks of the same immutable reference are removed');
        const items=j.jit.getCodeItems(method).length;
        t.equal(body.jvmStructuredFieldReadCacheCount,
          cacheLimit===undefined || items<=cacheLimit ? 2 : 0,
          'field-cache size limit includes the boundary');
      }
      const rebound=j.jit.materializeGeneratedResult(j.jit.serializeGeneratedResult(body),method);
      t.ok(rebound,name+' transports');
      for (const generated of [body,rebound]) for (const args of cases) {
        const objects={a:j.jit.newObjectSync('FieldReceiverChecks'),b:j.jit.newObjectSync('FieldReceiverChecks')};
        for(const [key,object] of Object.entries(objects)) for(const site of j.jit.fieldSites) {
          if(site?.className==='FieldReceiverChecks')j.jit.putFieldAtSite(site,object,
            (site.fieldName==='x'?3:5)+(key==='b'?10:0));
        }
        const actual=args.map(x=>objects[x]||x);
        const frame=new Frame(method);frame.className='FieldReceiverChecks';
        actual.forEach((x,i)=>frame.locals[i]=x);
        const thread={status:'runnable',callStack:new CallStack()};thread.callStack.push(frame);
        let result,error;
        try {result=await generated(frame,thread,j.jit,false);} catch(e) {error=e;}
        const normalize=x=>x===objects.a?'a':x===objects.b?'b':x;
        rows.push({name,args,result:result?.value,error:error?.type,
          pc:error?frame.pc:null,stack:error?frame.stack.items.map(normalize):null});
        if(args.includes(null) && !(name==='branch'&&args[2]===1))
          t.equal(error?.type,'java/lang/NullPointerException','null failure remains observable');
        else {
          t.ok(result?.returned,'valid receiver completes');
          t.equal(result.value,name==='read'?11:name==='replace'?18:8,'exact field arithmetic is preserved');
        }
      }
    }
    observations.push(rows);
  }
  for(const rows of observations.slice(1))
    t.deepEqual(rows,observations[0],'values and exact exception PCs/operands match unoptimized control');
  t.end();
});

test('field-cache size limit accepts only nonnegative safe integers',t=>{
  for(const [input,expected] of [[undefined,Infinity],[null,Infinity],[-1,Infinity],
    ['8',Infinity],[1.5,Infinity],[NaN,Infinity],[Infinity,Infinity],
    [Number.MAX_SAFE_INTEGER+1,Infinity],[0,0],[8,8],[Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER]]) {
    const j=new JVM({jit:{compileWorker:false,structuredFieldReadCacheMaxCodeItems:input}});
    t.equal(j.jit.structuredSsa.fieldReadCacheMaxCodeItems,expected,'validated limit '+String(input));
  }
  t.end();
});

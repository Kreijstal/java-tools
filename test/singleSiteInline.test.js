'use strict';
const test = require('tape'), fs = require('fs'), os = require('os'), path = require('path');
const frontend = require('../src/java-frontend');
const {JVM} = require('../src/core/jvm');
const Stack = require('../src/core/stack');
const {prepare} = require('../src/jit/SingleSiteInlineExperiment');

test('one restoring call expands with exact cold state and independent array simplification', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'single-site-inline-'));
  t.teardown(() => fs.rmSync(dir, {recursive:true, force:true}));
  const file = path.join(dir, 'InlineLoopCaller.java');
  fs.writeFileSync(file, `public class InlineLoopCaller {
    static void run(int[] a,int n) {
      for(int r=0;r<2;r++) { InlineLoopChild.span(a,n); }
    }
  }
  class InlineLoopChild {
    static int opaque;
    static int mask(int a,int b) { return a & b; }
    static void span(int[] a,int n) {
      int x=opaque;
      try { while(true) { n--; if(-1 < (n ^ -1)) break; a[n]=a[n]+mask(7,255); } }
      catch(RuntimeException e) { if(a==null) opaque=1; throw e; }
    }
  }`);
  frontend.compileJavaFile(file,{outputDir:dir});
  const all = [];
  for (const mode of ['control','expand','simplify']) {
    const spec = {caller:['InlineLoopCaller','run','([II)V'],
      callee:['InlineLoopChild','span','([II)V'], simplify:mode==='simplify', countEntries:true};
    const j = new JVM({classpath:dir,jit:{compileWorker:false,structuredSsa:true,
      singleSiteInlineExperiment:spec, checkedLeafDirectPositional:false,
      compiledCallChains:true, profileMethods:false, structuredContinuations:false,
      preferWholeMethodJs:true,ordinaryAdaptiveFramelessPositional:true,scalarGuestBodies:true,scalarLoops:true,
      prepareColdIntegerInlines:true}});
    await j.preloadClasspathClasses();
    await j.precompileInitializedClasses({initializedOnly:false,effectful:true,wasm:false});
    const parent = j.findMethod(j.classes.InlineLoopCaller,'run','([II)V');
    const child = j.findMethod(j.classes.InlineLoopChild,'span','([II)V');
    j.jit.getGeneratedFunction(child,{allowEffectfulCalls:true,compileLocally:true});
    const g = j.jit.getGeneratedFunction(parent,{allowEffectfulCalls:true,compileLocally:true});
    t.ok(g?.jvmRestoringDirectPositionalBody, 'caller restoring body exists');
    if (mode !== 'control') {
      const report = prepare(j.jit,spec);
      t.equal(report.simplify, mode==='simplify', 'simplification is independently selected');
      t.ok(g.jvmRestoringDirectPositionalSource.includes('const nestedEntryGuarded = true;'),
        'ordinary nested guard retained, not region-owned scheduling');
      t.ok(g.jvmRestoringDirectPositionalSource.includes('--safePointBudget'), 'child polling retained');
    }
    j._setClassInitializationState('InlineLoopCaller','INITIALIZED');
    j.classes.InlineLoopChild.staticFields.set('opaque:I',0);
    j._setClassInitializationState('InlineLoopChild','INITIALIZED');
    const rebound=j.jit.materializeGeneratedResult(j.jit.serializeGeneratedResult(g),parent);
    t.ok(rebound?.jvmRestoringDirectPositionalBody,'expanded parent transports');
    // Exercise the prepared restoring ABI directly, independently of the
    // generic dispatcher's hotness/frameless admission heuristics.
    for(const site of j.jit.syncCallSites.filter(s=>s?.callerMethod===parent&&s.methodName==='span')) {
      const target={method:child,lookupClass:'InlineLoopChild',generated:j.jit.codegenCache.get(child),freeFrame:null};
      const invoke=j.jit.getPositionalGeneratedInvoker(site,target);
      t.ok(invoke,'real prepared child invoker exists');
      site.fastStaticTarget=target;
      site.fastPositional={invoke,rawInvoke:null,lookupClass:'InlineLoopChild',receiverType:null,debugGuarded:true};
    }
    const observations=[];
    for (const [count,isNull,suspend] of
      [[2,false,false],[3,false,false],[2,true,false],[0,true,false],[600,false,true]]) for (const body of [g,rebound]) {
      const a=isNull?null:new Int32Array(count===600?600:2);
      const thread={status:'runnable',callStack:new Stack()};
      j.jit.continueStructuredQuantum=()=>!suspend;
      const invoke=j.jit.getPositionalGeneratedInvoker({op:'invokestatic',params:['int[]','int'],
        returnType:'void',descriptor:'([II)V',initializationToken:{initialized:true}},
        {method:parent,lookupClass:'InlineLoopCaller',generated:body,freeFrame:null});
      let result,error;
      const beforeEntries=j.jit.singleSiteInlineEntries||0;
      try {result=invoke(a,count,thread);} catch(e) {error=e;}
      if(mode!=='control'&&count===2&&!isNull&&!(j.jit.singleSiteInlineEntries>beforeEntries))t.comment(JSON.stringify({
        rebound:body===rebound,source:body.jvmRestoringDirectPositionalBody.jvmGeneratedSource.includes('singleSite'),
        sites:j.jit.syncCallSites.filter(s=>s?.callerMethod===parent&&s.methodName==='span').map(s=>({id:s.id,identity:s.fastPositional?.invoke?.jvmInlineRestoringBody===j.jit.singleSiteInlineTargetBody}))}));
      if(mode!=='control'&&count===2&&!isNull)t.ok(j.jit.singleSiteInlineEntries>beforeEntries,
        'selected original/transported body executes the insertion');
      const normalize=v=>v===a&&a!==null?'array':typeof v==='symbol'?String(v):v;
      observations.push({pixels:a&&[...a],error:error?.type||error?.message||null,
        result:typeof result==='symbol'?String(result):result&&{deopt:result.deopt,reason:result.reason},
        frames:thread.callStack.items.map(f=>({method:f.method.name,pc:f.pc,
          locals:f.locals.map(normalize),stack:f.stack.items.map(normalize)}))});
    }
    if(mode!=='control')t.ok(j.jit.singleSiteInlineEntries>0,'the expanded site really executes');
    if(observations[0].pixels?.[0]!==14)t.comment(JSON.stringify(observations[0]));
    t.deepEqual(observations[0].pixels,[14,14],'both caller iterations execute the span');
    t.ok(observations[2].error,'bounds case really throws');
    t.ok(observations[4].error,'null case really throws');
    t.notOk(observations[6].error,'null zero-trip loop does not throw');
    t.ok(observations[8].result?.deopt,'long loop really suspends');
    t.ok(observations[8].frames.some(f=>f.method==='span'),'suspension restores the child');
    if(mode!=='control') {
      const saved=j.jit.singleSiteInlineTargetBody;
      j.jit.singleSiteInlineTargetBody=()=>{};
      j.jit.continueStructuredQuantum=()=>true;
      const count=j.jit.singleSiteInlineEntries;
      const a=new Int32Array(2),thread={status:'runnable',callStack:new Stack()};
      const invoke=j.jit.getPositionalGeneratedInvoker({op:'invokestatic',params:['int[]','int'],
        returnType:'void',descriptor:'([II)V',initializationToken:{initialized:true}},
        {method:parent,lookupClass:'InlineLoopCaller',generated:g,freeFrame:null});
      invoke(a,2,thread);
      t.deepEqual([...a],[14,14],'body identity mismatch executes canonical callee');
      t.equal(j.jit.singleSiteInlineEntries,count,'mismatched body never executes stale insertion');
      j.jit.singleSiteInlineTargetBody=saved;
    }
    for(const state of [undefined,'INITIALIZING','ERRONEOUS']) {
      j._setClassInitializationState('InlineLoopChild',state);
      const a=new Int32Array(2),thread={status:'runnable',callStack:new Stack()};
      const invoke=j.jit.getPositionalGeneratedInvoker({op:'invokestatic',params:['int[]','int'],
        returnType:'void',descriptor:'([II)V',initializationToken:{initialized:true}},
        {method:parent,lookupClass:'InlineLoopCaller',generated:g,freeFrame:null});
      try { invoke(a,2,thread); } catch (_) { /* Canonical erroneous-init path may throw. */ }
      t.deepEqual([...a],[0,0], 'unready class never executes inserted guest effects');
      t.equal(j.classInitializationState.get('InlineLoopChild'),state,'preparation/guard does not initialize guest class');
    }
    j.guestStarted = true;
    t.throws(()=>prepare(j.jit,spec),/pre-main/, 'no post-main compiler entry');
    j.guestStarted = false;
    all.push(observations);
  }
  for(let arm=1;arm<all.length;arm++)for(let c=0;c<all[0].length;c++)t.deepEqual(all[arm][c],all[0][c],
    'arm '+arm+' case '+c+' cold frame state matches control');
  t.end();
});

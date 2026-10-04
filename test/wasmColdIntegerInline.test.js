"use strict";
const test = require('tape');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const {JVM} = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');
const {inlineCalls} = require('../src/jit/wasmInline');
const fixture = makeJavaFixtureCompiler('wasm-cold-integer-inline-');
const source = `public class ColdMaskDrive {
  static int effects, order;
  static void drive(int[] out, int x) {
    effects += 10;
    for (int i=0;i<out.length;i++) {
      out[i] = x < 0 ? 9 : ColdMask.mask(x+i,7);
      effects++;
    }
  }
}
class ColdMask {
  static int calls;
  static int ignored = init();
  static int init() { calls++; ColdMaskDrive.order = ColdMaskDrive.effects; return 1; }
  static int mask(int x, int y) { return x & y; }
  static int write(int x, int y) { calls++; return x & y; }
  static int divide(int x, int y) { return x / y; }
}`;
for (const heap of [false, true]) test(`cold integer inlining preserves initialization and effects (heap=${heap})`, async t => {
  const classpath = fixture(t, 'ColdMaskDrive', source);
  const j = new JVM({classpath,wasmHeap:heap,wasmHeapMb:1,prepareBeforeMain:false,
    jit:{codegen:false,compileWorker:false,wasm:{structured:true,inlineColdIntegerLeaves:true}}});
  await j.preloadClasspathClasses();
  j._markClassInitialized('ColdMaskDrive');
  j.classes.ColdMaskDrive.staticFields.set('effects:I',0);
  j.classes.ColdMaskDrive.staticFields.set('order:I',0);
  const m = j.findMethod(j.classes.ColdMaskDrive,'drive','([II)V');
  const code = m.attributes.find(a=>a.type==='code');
  t.equal(inlineCalls(j,code),null,'default policy retains the cold static call');
  const expanded = inlineCalls(j,code,{inlineColdIntegerLeaves:true});
  t.deepEqual(expanded?.coldStaticInlineOwners,['ColdMask'],'the actual cold owner is recorded');
  const invoke = code.code.codeItems.find(i=>i.instruction?.op==='invokestatic');
  for (const name of ['write','divide']) {
    const changed = {...code,code:{...code.code,codeItems:code.code.codeItems.map(i=>i===invoke?
      {...i,instruction:{...i.instruction,arg:['Method','ColdMask',[name,'(II)I']]}}:i)}};
    t.equal(inlineCalls(j,changed,{inlineColdIntegerLeaves:true}),null,`rejects ${name} with observable effects or exceptions`);
  }
  const w=j.jit.wasmJit;w.enabled=true;
  const st=w.methodState({method:m});w.compile({method:m,className:'ColdMaskDrive'},st,{asCallee:true});
  t.equal(st.status,'ready','cold caller compiles');
  t.equal(st.meta?.inlinedCalls,1,'mask is spliced before initialization');
  t.ok(st.meta?.initializationGuardTokens.some(token=>!token.initialized),'entry has a live readiness guard');
  if(st.status!=='ready'){t.end();return;}
  const thread={id:0,status:'runnable',callStack:new Stack(),pendingException:null};j.threads=[thread];j.currentThreadIndex=0;
  const field=(c,k)=>j.classes[c].staticFields.get(k+':I')||0;
  const run=async(x,fuel)=>{
    const out=new Int32Array(3),frame=new Frame(m);frame.className='ColdMaskDrive';frame.locals[0]=out;frame.locals[1]=x;
    thread.callStack.push(frame);const raw=st.run;
    if(fuel!==undefined)st.run=(...args)=>{args[args.length-1]=fuel;return raw(...args);};
    try{w.runNested(frame,thread);}finally{st.run=raw;}
    let ticks=0;while(thread.callStack.size()){await j.executeTick();if(++ticks>100000)throw Error('cold inline resume limit');}
    return Array.from(out);
  };
  t.deepEqual(await run(-5),[9,9,9],'untaken helper path computes exact values');
  t.equal(field('ColdMask','calls'),0,'entry check does not initialize an untaken owner');
  t.equal(field('ColdMaskDrive','effects'),13,'effects run once on the cold untaken path');
  t.deepEqual(await run(5),[5,6,7],'taken path initializes at the original invocation');
  t.equal(field('ColdMaskDrive','order'),23,'initializer observes the preceding caller write');
  t.equal(field('ColdMask','calls'),1,'initializer runs once');
  for(const fuel of [undefined,1,2,5]) {
    const before=field('ColdMaskDrive','effects');
    t.deepEqual(await run(7,fuel),[7,0,1],`warm inline results remain exact with fuel=${fuel}`);
    t.equal(field('ColdMaskDrive','effects'),before+13,'caller writes are never replayed');
  }
  w.compile({method:m,className:'ColdMaskDrive'},st,{asCallee:true});
  t.equal(st.meta?.inlinedCalls,1,'warm recompilation retains the inline');
  t.ok(st.meta?.initializationGuardTokens.length,'warm recompilation retains the invalidation guard');
  j.classInitializationState.delete('ColdMask');
  const before=field('ColdMaskDrive','effects');
  t.deepEqual(await run(2),[2,3,4],'invalidated owner safely reinitializes');
  t.equal(field('ColdMaskDrive','order'),before+10,'invalidation preserves original initialization order');
  t.equal(field('ColdMask','calls'),2,'live guard observes invalidation');
  t.equal(st.meta.box.frame,null,'completed invocation releases its frame');
  t.end();
});

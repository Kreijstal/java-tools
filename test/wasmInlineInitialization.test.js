'use strict';
const test = require('tape');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const {JVM} = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');
const fixture = makeJavaFixtureCompiler('wasm-inline-initialization-');

for (const linearHeap of [false, true]) {
  test(`inlined readiness guards preserve cold paths and effects (heap=${linearHeap})`, async t => {
    const classpath = fixture(t, 'InlineInit', `public final class InlineInit {
      static int effects, order;
      private int sample(int x) {
        effects++;
        if (x < 0) return 5;
        return InlineTarget.value + x;
      }
      public void drive(int[] out, int x) {
        effects += 10;
        for (int i=0;i<out.length;i++) out[i] = sample(x+i);
      }
      public void loop(int[] out, int x) {
        while (x > 0) { --x; out[x] = sample(x); }
      }
    }
    class InlineTarget {
      static int calls;
      static int value = init();
      static int init() { calls++; InlineInit.order = InlineInit.effects; return 11; }
    }`);
    const j = new JVM({classpath, wasmHeap:linearHeap, wasmHeapMb:1,
      prepareBeforeMain:false, jit:{codegen:false,compileWorker:false,wasmStructured:true}});
    await j.preloadClasspathClasses();
    j.classInitializationState.set('InlineInit','INITIALIZED');
    j.classes.InlineInit.staticFields.set('effects:I',0);
    j.classes.InlineInit.staticFields.set('order:I',0);
    const w = j.jit.wasmJit; w.enabled = true;
    const method = await j.findMethodInHierarchy('InlineInit','drive','([II)V');
    const state = w.methodState({method});
    w.compile({method,className:'InlineInit'},state,{asCallee:true});
    t.equal(state.status,'ready','prepared before target initialization');
    t.equal(state.meta.inlinedCalls,1,'keeps the inlined helper while the target is cold');
    t.ok(state.meta.initializationGuardTokens.some(token => !token.initialized),'retains readiness dependency');
    const thread = {id:0,status:'runnable',callStack:new Stack(),pendingException:null};
    j.threads=[thread]; j.currentThreadIndex=0;
    const get = (owner,name) => j.classes[owner].staticFields.get(name+':I') || 0;
    const run = async (x, selectedMethod = method) => {
      const out = new Int32Array(3), frame = new Frame(selectedMethod);
      frame.className='InlineInit';
      frame.locals[0]={type:'InlineInit',fields:{}};
      frame.locals[1]=out; frame.locals[2]=x;
      thread.callStack.push(frame);
      w.runNested(frame,thread);
      let ticks=0;
      while(thread.callStack.size()) {
        await j.executeTick();
        if(++ticks>100000) throw new Error('tick limit');
      }
      return [...out];
    };
    t.deepEqual(await run(-5),[5,5,5],'untaken static access returns normally');
    t.equal(get('InlineInit','effects'),13,'cold fallback does not replay caller or helper writes');
    t.equal(get('InlineTarget','calls'),0,'readiness check never initializes an untaken dependency');
    t.notEqual(j.classInitializationState.get('InlineTarget'),'INITIALIZED','target stays cold');
    t.deepEqual(await run(0),[11,12,13],'cold taken access initializes and computes exact results');
    t.equal(get('InlineInit','effects'),26,'writes execute once around initialization');
    t.equal(get('InlineInit','order'),24,'initializer observes original guest ordering');
    t.equal(get('InlineTarget','calls'),1,'initializer executes once');
    const exits=state.exits||0;
    t.deepEqual(await run(3),[14,15,16],'warm inline execution returns exact values');
    t.equal(get('InlineInit','effects'),39,'warm writes execute once');
    t.equal(state.exits||0,exits,'warm call has no readiness exit');
    j.classInitializationState.delete('InlineTarget');
    t.deepEqual(await run(0),[11,12,13],'token invalidation safely returns through initialization');
    t.equal(get('InlineInit','effects'),52,'invalidated call preserves once-only effects');
    t.equal(get('InlineInit','order'),50,'reinitialization occurs at original guest access');
    t.equal(get('InlineTarget','calls'),2,'invalidation is observed');
    t.equal(state.meta.box.frame,null,'invocation frame is released');
    j.classInitializationState.delete('InlineTarget');
    const loop = await j.findMethodInHierarchy('InlineInit','loop','([II)V');
    const loopState = w.methodState({method:loop});
    w.compile({method:loop,className:'InlineInit'},loopState,{asCallee:true});
    t.equal(loopState.status,'ready','entry-loop caller prepares');
    t.equal(loopState.meta.inlinedCalls,1,'entry-loop caller retains inlining');
    t.deepEqual(await run(3,loop),[11,12,13],'entry guard spills original loop parameters');
    t.equal(get('InlineInit','effects'),55,'entry-loop cold fallback executes each write once');
    t.equal(get('InlineInit','order'),53,'entry-loop initializer observes first helper write');
    t.deepEqual(await run(3,loop),[11,12,13],'entry-loop phi seeding preserves warm results');
    t.end();
  });
}

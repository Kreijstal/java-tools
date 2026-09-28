'use strict';
const test = require('tape');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const {JVM} = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');
const compile = makeJavaFixtureCompiler('wasm-initialized-leaf-');

for (const linearHeap of [false, true]) {
test(`prepared static-field leaf links preserve initialization (linearHeap=${linearHeap})`, async t => {
  const previous = process.env.JVM_WASM_INLINE;
  process.env.JVM_WASM_INLINE = '0';
  t.teardown(() => { if (previous === undefined) delete process.env.JVM_WASM_INLINE; else process.env.JVM_WASM_INLINE = previous; });
  const classpath = compile(t, 'InitializedLeaf', `
public class InitializedLeaf {
  private int sample(int x) { LinkTarget.value += x + LinkOther.value; return LinkTarget.value; }
  public void drive(int[] out) { for (int i = 0; i < out.length; i++) out[i] = sample(i + 1); }
}
class LinkOther {
  static int calls;
  static int value = init();
  static int init() { calls++; return 0; }
}
class LinkTarget {
  static int calls;
  static int value = init();
  static int init() { calls++; return 11; }
}`);
  const j = new JVM({classpath, wasmHeap:linearHeap, wasmHeapMb:1, prepareBeforeMain:false, jit:{codegen:false, compileWorker:false, wasmStructured:true}});
  await j.preloadClasspathClasses();
  j.classInitializationState.set('InitializedLeaf', 'INITIALIZED');
  const w=j.jit.wasmJit;w.enabled=true;
  const prepare=async(name,desc)=>{
    const method=await j.findMethodInHierarchy('InitializedLeaf',name,desc),state=w.methodState({method});
    w.compile({method,className:'InitializedLeaf'},state,{asCallee:true});
    t.equal(state.status,'ready',name+' prepared');return {method,state};
  };
  const leaf=await prepare('sample','(I)I'),caller=await prepare('drive','([I)V');
  t.equal(leaf.state.meta.deoptableCalls,2,'leaf retains both cold-class exits');
  t.ok(caller.state.meta.directLinks>0,'caller emits a guarded direct link before class initialization');
  const thread={id:0,status:'runnable',callStack:new Stack(),pendingException:null};j.threads=[thread];j.currentThreadIndex=0;
  const receiver={type:'InitializedLeaf',fields:{},hashCode:1};
  const run=async(object=receiver)=>{
    const out=new Int32Array(3),frame=new Frame(caller.method);frame.className='InitializedLeaf';frame.locals[0]=object;frame.locals[1]=out;
    thread.callStack.push(frame);w.runNested(frame,thread);
    let ticks=0;while(thread.callStack.size()) {await j.executeTick();if(++ticks>100000)throw new Error('tick limit');}
    return [...out];
  };
  t.deepEqual(await run(),[12,14,17],'cold fallback initializes and executes each write exactly once');
  t.equal(j.classes.LinkTarget.staticFields.get('calls:I'),1,'first initializer ran once');
  t.equal(j.classes.LinkOther.staticFields.get('calls:I'),1,'second initializer ran once');
  const before=leaf.state.nestedCalls||0;
  t.deepEqual(await run(),[18,20,23],'warm direct calls preserve all results');
  t.equal(leaf.state.nestedCalls||0,before,'warm calls avoid the JavaScript nested bridge');
  j.classInitializationState.delete('LinkTarget');
  t.deepEqual(await run(),[12,14,17],'invalidated token goes through initializer again safely');
  t.equal(j.classes.LinkTarget.staticFields.get('calls:I'),2,'invalidation was observed');
  t.ok((leaf.state.nestedCalls||0)>before,'cold reentry uses the frame-owning bridge');
  j.classInitializationState.clear();
  t.deepEqual(await run(),[12,14,17],'clearing initialization states invalidates all flags');
  let thrown;
  try { await run(null); } catch (error) { thrown = error; }
  t.equal(thrown?.type,'java/lang/NullPointerException','null receiver keeps the guest exception');
  t.equal(leaf.state.meta.box.frame,null,'direct and fallback paths release invocation frames');
  t.end();
});

}

test('initialization-only link admission requires an explicit guard and excludes other exits', t => {
  const {directInstanceLinkCalleeEligible: eligible} = require('../src/jit/wasmShared');
  const meta={fullyCompiled:true,runv:()=>{},deoptableCalls:1,initializationGuardLeaf:true,initializationGuardTokens:[{initialized:false}]};
  const state={meta};
  t.notOk(eligible(state,true),'unguarded backends keep the frame-owning path');
  t.ok(eligible(state,true,null,true),'guard-capable backend may link a cold leaf');
  for(const change of [{initializationGuardLeaf:false},{deoptableCalls:2},{usedEh:true},{boxedCount:1},{fullyCompiled:false},{initializationGuardTokens:[]}])
    t.notOk(eligible({meta:{...meta,...change}},true,null,true),'refuses '+Object.keys(change)[0]);
  t.notOk(eligible({...state,synchronized:true},true,null,true),'monitor still requires a frame');
  t.notOk(eligible({...state,linkVetoed:true},true,null,true),'veto still applies');
  t.end();
});

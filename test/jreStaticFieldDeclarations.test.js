'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm');
const Frame=require('../src/core/frame');
const Stack=require('../src/core/stack');
const {makeJavaFixtureCompiler}=require('./javaFixture');
const fixture=makeJavaFixtureCompiler('lazy-jre-fields-');

test('System stream declarations are visible before initialization without changing storage',t=>{
 const j=new JVM({jit:{enabled:false,compileWorker:false}}),fields=j.jre['java/lang/System'].staticFields;
 const before=[...fields];
 const mirror=j.getClassObjectSync('java/lang/System'),items=mirror._classData.ast.classes[0].items;
 for(const name of ['in','out','err']){
  const matches=items.filter(i=>i.type==='field'&&i.field.name===name);
  t.equal(matches.length,1,'one declared '+name+' field');
  t.equal(matches[0].field.descriptor,name==='in'?'Ljava/io/InputStream;':'Ljava/io/PrintStream;','exact declared stream type');
  t.equal(matches[0].field.accessFlags,0x0019,'public static final flags');
 }
 t.deepEqual([...fields],before,'reflection does not create or initialize stream cells');
 t.notEqual(j.classInitializationState.get('java/lang/System'),'INITIALIZED','class literal keeps System cold');
 t.equal(j.getClassObjectSync('java/lang/System'),mirror,'class mirror identity is stable');
 t.end();
});

test('cold native static declarations retain initialization ordering and live storage in Wasm',async t=>{
 const classpath=fixture(t,'LazyRead',`public class LazyRead {
   public static int effects;
   public static Object read(boolean taken){
     effects++;
     return taken ? LazyNative.value : null;
   }
 }
 class LazyNative {public static Object value;}`);
 let initialized=0,observedEffects;
 const marker={type:'java/lang/Object',fields:{}},storage=new Map();
 const native={super:'java/lang/Object',staticFields:storage,
  staticFieldDeclarations:[{name:'value',descriptor:'Ljava/lang/Object;'}],
  methods:{'<clinit>()V':j=>{initialized++;observedEffects=j.classes.LazyRead.staticFields.get('effects:I');j.classes.LazyNative.staticFields.set('value:Ljava/lang/Object;',marker);}}};
 const j=new JVM({classpath,prepareBeforeMain:false,jit:{enabled:false,compileWorker:false,wasm:{structured:true,deepInline:false}}});
 j.jre.LazyNative=native;j.getClassObjectSync('LazyNative');
 await j.loadClassByName('LazyRead');j.classes.LazyRead.staticFieldsInitialized=true;j._markClassInitialized('LazyRead');j.classes.LazyRead.staticFields.set('effects:I',0);
 t.equal(storage.size,0,'declaration leaves native field storage empty');
 const w=j.jit.wasmJit;w.enabled=true;
 const method=j.findMethod(j.classes.LazyRead,'read','(Z)Ljava/lang/Object;'),state=w.methodState({method});
 w.compile({method,className:'LazyRead'},state,{asCallee:true});
 t.equal(state.status,'ready','method compiles against cold declaration');
 t.ok(state.meta.structured&&state.meta.normalFlowFullyCompiled,'cold field introduces no coverage gap');
 t.ok(state.meta.initializationGuardTokens.some(token=>!token.initialized),'initializer guard remains live');
 t.equal(initialized,0,'compilation does not initialize the native dependency');
 const thread={id:0,status:'runnable',callStack:new Stack(),pendingException:null};j.threads=[thread];j.currentThreadIndex=0;
 const run=async taken=>{const caller=new Frame(method),frame=new Frame(method);frame.className='LazyRead';frame.locals[0]=taken?1:0;thread.callStack.push(caller);thread.callStack.push(frame);
 t.ok(w.tryRunFrame(frame,thread).handled,'real native frame entry selected');
 let ticks=0;while(thread.callStack.size()>1){await j.executeTick();if(++ticks>10000)throw Error('resume limit');}
 const value=caller.stack.pop();thread.callStack.pop();return value;};
 t.equal(await run(false),null,'untaken cold access returns null');
 t.equal(initialized,0,'untaken branch never initializes native class');
 t.equal(await run(true),marker,'taken access returns the original initialized object');
 t.equal(initialized,1,'initializer executes once at first active use');
 t.equal(observedEffects,2,'initializer observes exactly the preceding guest effects');
 t.equal(j.classes.LazyRead.staticFields.get('effects:I'),2,'resume does not replay guest writes');
 const replacement={type:'java/lang/Object',fields:{replacement:true}};storage.set('value:Ljava/lang/Object;',replacement);
 t.equal(await run(true),replacement,'warm read observes replacement through the live field cell');
 t.equal(initialized,1,'warm replacement does not rerun initialization');
 const second=new JVM({jit:{enabled:false,compileWorker:false}});second.jre.LazyNative=native;
 const fields=second.getClassObjectSync('LazyNative')._classData.ast.classes[0].items.filter(i=>i.type==='field');
 t.equal(fields.filter(i=>i.field.name==='value').length,1,'populated cells do not duplicate explicit declarations');
 t.end();
});

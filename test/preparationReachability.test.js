const test = require('tape');
const {JVM} = require('../src/core/jvm');
const {reachablePreparationMethods} = require('../src/jit/PreparationPolicy');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const fixture = makeJavaFixtureCompiler('preparation-reachability-');

test('entry preparation follows class initializers, inherited calls and interface implementations', async t => {
  const classpath = fixture(t, 'Reachable', `
    public class Reachable {
      static int entry() { return new Child().run() + read(new Other()) + read(factory()) + Holder.value; }
      static int read(Action action) { return action.run(); }
      static Action factory() { return new Late(); }
      static int unused() { return 99; }
    }
    interface Action { int run(); }
    class Parent implements Action { public int run() { return helper(); } static int helper() { return 3; } }
    class Child extends Parent {}
    class Other implements Action { public int run() { return 4; } }
    class Late implements Action { public int run() { return 5; } }
    class Unused implements Action { public int run() { return 99; } }
    class Holder { static int value=initialize(); static int initialize() { return 7; } }
  `);
  const jvm = new JVM({classpath,jit:{compileWorker:false,structuredSsa:true}});
  await jvm.preloadClasspathClasses();
  const all = Object.entries(jvm.classes).flatMap(([className, data]) =>
    (data.ast?.classes?.[0]?.items || []).filter(item => item.type === 'method')
      .map(item => ({className, method:item.method})));
  const key = entry => `${entry.className}.${entry.method.name}${entry.method.descriptor}`;
  const selected = reachablePreparationMethods(all, ['Reachable.entry()I'], jvm.classes).map(key);
  for (const expected of ['Reachable.entry()I','Reachable.read(LAction;)I',
    'Parent.run()I','Parent.helper()I','Other.run()I','Late.run()I','Holder.<clinit>()V','Holder.initialize()I']) {
    t.ok(selected.includes(expected), expected);
  }
  t.notOk(selected.includes('Reachable.unused()I'), 'unrelated method is not prepared');
  t.notOk(selected.includes('Unused.run()I'), 'unallocated implementation stays on normal execution paths');
  t.notEqual(jvm.classInitializationState.get('Holder'),'INITIALIZED','selection never runs class initializers');
  t.throws(() => reachablePreparationMethods(all,['Missing.entry()V'],jvm.classes), /Unknown preparation/);
  t.deepEqual(reachablePreparationMethods(all,[],jvm.classes),[], 'empty roots select no methods');
  const result=await jvm.precompileInitializedClasses({initializedOnly:false,effectful:true,wasm:false,
    preparationPolicy:{entryMethods:['Reachable.entry()I']}});
  const expected=all.filter(entry=>selected.includes(key(entry)) && entry.method.name!=='<clinit>' &&
    entry.method.attributes?.some(attribute=>attribute.type==='code')).length;
  t.equal(result.report.methods,expected,'JVM preparation applies reachability before compiling');
  t.notOk(jvm.guestStarted,'preparation never enters the guest');
  t.notEqual(jvm.classInitializationState.get('Holder'),'INITIALIZED','compilation preserves initialization order');
  t.end();
});

test('unknown dynamic targets do not expand a preparation scope to the whole program', t => {
  for (const instruction of [{op:'invokedynamic'},
    {op:'invokestatic',arg:['Method','java/lang/Class',['forName','(Ljava/lang/String;)Ljava/lang/Class;']]}]) {
    const method={name:'entry',descriptor:'()V',attributes:[{type:'code',code:{codeItems:[{instruction}]}}]};
    const all=[{className:'A',method},{className:'A',method:{name:'other',descriptor:'()V'}}];
    const classes={A:{ast:{classes:[{items:all.map(entry=>({type:'method',method:entry.method}))}]}}};
    t.deepEqual(reachablePreparationMethods(all,['A.entry()V'],classes),[all[0]],'known entry is prepared; unknown callees keep runtime fallbacks');
  }
  t.end();
});

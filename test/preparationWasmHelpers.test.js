'use strict';
const test = require('tape');
const {JVM} = require('../src/core/jvm');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const compile = makeJavaFixtureCompiler('prepare-wasm-helpers-');

test('preparation can explicitly include selected non-loop Wasm dependencies', async t => {
  const classpath = compile(t, 'PreparedHelpers', `
public class PreparedHelpers {
  static int bits(int value) { return value & 255; }
  static byte next(int value) { return (byte)bits(value); }
  static int sum(int count) {
    int total = 0;
    for (int i = 0; i < count; i++) total += next(i + 254);
    return total;
  }
  public static void main(String[] args) { System.out.println(sum(4)); }
}`);
  const priorityMethods = ['PreparedHelpers.bits(I)I',
    'PreparedHelpers.next(I)B', 'PreparedHelpers.sum(I)I'];
  for (const includeHelpers of [false, true, 'selected', 'selected-upgrades']) {
    const output = [];
    const policy = {priorityMethods, maxMethods: 3};
    if (includeHelpers === true) policy.wasmLoopsOnly = false;
    if (typeof includeHelpers === 'string') policy.wasmCalleeMethods = priorityMethods.slice(0,2);
    const j = new JVM({classpath, prepareBeforeMain: false, jit: {
      compileWorker: false, wasmStructured: true, preparationPolicy: policy,
    }});
    j.jit.wasmJit.enabled = true;
    await j.preloadClasspathClasses();
    const result = await j.precompileInitializedClasses({
      initializedOnly: false, effectful: true, wasm: true,
      wasmPreparedUpgradesOnly: includeHelpers === 'selected-upgrades',
    });
    if (includeHelpers === 'selected-upgrades') {
      t.ok(result.wasmMethods >= 2, 'selected helpers prepare while the upgrades-only filter remains enabled');
    } else t.equal(result.wasmMethods, includeHelpers ? 3 : 1,
      includeHelpers ? 'explicit policy prepares all three selected methods'
        : 'default Wasm preparation remains limited to loops');
    if (includeHelpers) {
      for (const [name, descriptor] of [['bits', '(I)I'], ['next', '(I)B']]) {
        const method = await j.findMethodInHierarchy('PreparedHelpers', name, descriptor);
        const state = j.jit.wasmJit.state.get(method);
        t.equal(state?.status, 'ready', `${name} has a ready Wasm module`);
        t.ok(state?.meta?.fullyCompiled, `${name} has complete coverage`);
      }
    }
    j.registerJreMethods({'java/io/PrintStream': {
      'println(I)V': (_j, _o, args) => output.push(args[0]),
    }});
    await j.run('PreparedHelpers');
    t.deepEqual(output, [-2], 'prepared helper chain preserves signed-byte results');
  }
  t.end();
});

test('AOT follows cold static helper links without running their class initializer', async t => {
  const classpath = compile(t, 'ColdHelperMain', `
class ColdHelperTrace { static int initialized; }
class ColdHelper {
  static int factor = 3;
  static { ColdHelperTrace.initialized++; }
  static int leaf(int x) { return x * factor + 1; }
}
public class ColdHelperMain {
  static int result;
  static int loop(int n) { int sum=0; for(int i=0;i<n;i++) sum+=ColdHelper.leaf(i); return sum; }
  public static void main(String[] args) { result=loop(100); }
}`);
  const j = new JVM({classpath, prepareBeforeMain: false, jit: {
    compileWorker: false, wasmStructured: true, structuredSsa: true,
    rendererPipeline: true, compiledCallChains: true,
    preparedWasmMethods: ['ColdHelperMain.loop(I)I'],
    wasm: {noOnDemandCalleeCompile: true, maxInlineCalleeItems: 1, inlineBudget: 1},
  }});
  await j.preloadClasspathClasses();
  const w=j.jit.wasmJit; w.enabled=true;
  const {report}=await j.precompileInitializedClasses({initializedOnly:false,
    effectful:true,wasm:true,wasmPreparedUpgradesOnly:true});
  const leaf=await j.findMethodInHierarchy('ColdHelper','leaf','(I)I');
  t.equal(w.state.get(leaf)?.status,'ready','reachable non-loop helper compiled before first use');
  t.ok(report.wasmLinkedCallees>0,'preparation reports dependency compilation');
  t.notEqual(j.classInitializationState.get('ColdHelper'),'INITIALIZED','helper class remains cold');
  w.freezeCompilation();
  const late=[];
  const start=j.jit.startSynchronousCompile.bind(j.jit);
  j.jit.startSynchronousCompile=(method,entry)=>{
    if(j.jit.mainStarted)late.push({method:j.jit.methodIdentity(method),entry,stack:new Error().stack});
    return start(method,entry);
  };
  await j.run('ColdHelperMain',{prepare:false});
  await new Promise(resolve=>setTimeout(resolve,10));
  t.equal(j.classes.ColdHelperMain.staticFields.get('result:I'),14950,'correct result after initialization');
  t.equal(j.classes.ColdHelperTrace.staticFields.get('initialized:I'),1,'initializer ran once at execution');
  t.deepEqual(late,[],'no guest-time JavaScript or Wasm compilation');
  t.end();
});

test('AOT includes dependencies of modules compiled outside the root candidate list', async t => {
  const classpath=compile(t,'NestedPreparedChild',`
class NestedPreparedLeaf {
  static int factor=3;
  static int leaf(int value) { return value*factor; }
}
public class NestedPreparedChild {
  static int loop(int n) { int sum=0; for(int i=0;i<n;i++) sum+=NestedPreparedLeaf.leaf(i); return sum; }
}`);
  const j=new JVM({classpath,prepareBeforeMain:false,jit:{compileWorker:false,
    wasmStructured:true,wasm:{noOnDemandCalleeCompile:true,maxInlineCalleeItems:1,inlineBudget:1}}});
  await j.preloadClasspathClasses();
  const loop=await j.findMethodInHierarchy('NestedPreparedChild','loop','(I)I');
  const leaf=await j.findMethodInHierarchy('NestedPreparedLeaf','leaf','(I)I');
  const w=j.jit.wasmJit;w.enabled=true;
  const child={className:'NestedPreparedChild',method:loop};
  w.compile(child,w.methodState(child),{asCallee:true,entryPath:'prepare-test-child'});
  t.equal(w.state.get(loop)?.status,'ready','child module exists before the dependency pass');
  t.notEqual(w.state.get(leaf)?.status,'ready','cold owner deferred the helper');
  const roots=[];
  const compiled=await j.prepareWasmLinkedCallees(roots,
    [child,{className:'NestedPreparedLeaf',method:leaf}]);
  t.ok(compiled>0,'dependency pass finds work with an empty original root list');
  t.equal(w.state.get(leaf)?.status,'ready','helper of the previously compiled child is prepared');
  t.notEqual(j.classInitializationState.get('NestedPreparedLeaf'),'INITIALIZED','helper owner remains uninitialized');
  t.end();
});

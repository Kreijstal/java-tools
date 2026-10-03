'use strict';
const test = require('tape');
const {JVM} = require('../src/core/jvm');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const Stack = require('../src/core/stack');
const compileFixture = makeJavaFixtureCompiler('region-admission-budget-');

for (const budget of ['methods', 'bytecode']) {
  test(`region ${budget} budget leaves unadmitted callees at canonical boundaries`, async t => {
    const classpath = compileFixture(t, 'RegionAdmission', `public class RegionAdmission {
      static int visits;
      static int a(int v, boolean flag) { return v * 3 + (flag ? 1 : 2); }
      static int b(int v, boolean flag) { visits++; return v * 5 + (flag ? 3 : 4); }
      static int c(int v, boolean flag) { return v * 7 + (flag ? 5 : 6); }
      static int root(int n, boolean flag) {
        int sum = 0;
        for (int i = 0; i < n; i++) {
          sum += a(i, flag) + b(i, flag) + c(i, flag) + a(i + 1, flag);
        }
        return sum;
      }
    }`);
    const jvm = new JVM({classpath, jit: {
      compileWorker: false, structuredSsa: true,
      hotCallGraphRegions: true, profileMethods: false,
    }});
    const jit = jvm.jit;
    const compiler = jit.hotCallGraphRegions;
    await jvm.loadClassByName('RegionAdmission');
    jvm.classInitializationState.set('RegionAdmission', 'INITIALIZED');
    jvm.classes.RegionAdmission.staticFields.set('visits:I', 0);
    const methods = {};
    for (const name of ['a', 'b', 'c', 'root']) {
      methods[name] = await jvm.findMethodInHierarchy('RegionAdmission', name, '(IZ)I');
      jit.getGeneratedFunction(methods[name]);
    }
    if (budget === 'methods') {
      compiler.maxMethods = 2;
    } else {
      compiler.maxCodeItems = jit.getCodeItems(methods.root).length +
        jit.getCodeItems(methods.a).length;
    }
    const requested = [];
    const getCandidate = jit.getStructuredRegionCandidate;
    jit.getStructuredRegionCandidate = function(method, ...args) {
      requested.push(method.name);
      return getCandidate.call(this, method, ...args);
    };
    let plan;
    try {
      plan = jit.compileHotCallGraphRegion(methods.root);
    } finally {
      jit.getStructuredRegionCandidate = getCandidate;
    }
    t.ok(plan?.backendEligible, 'bounded prefix forms an executable group');
    t.notOk(requested.includes('b') || requested.includes('c'),
      'over-budget callees are not lowered for the group');
    t.deepEqual(plan?.nodes.map(node => node.method.name), ['root', 'a'],
      'repeated calls share one admitted node');
    const reason = budget === 'methods' ? 'method-budget' : 'bytecode-budget';
    t.equal(plan?.root.boundaries.filter(boundary => boundary.reason === reason).length, 2,
      'both omitted calls retain explicit boundaries');
    t.equal(plan?.closed, false, 'partial group is not reported as closed');
    if (plan?.positionalBody) {
      const thread = {status: 'runnable', callStack: new Stack()};
      jvm._nextEventLoopYieldAt = Infinity;
      for (const flag of [false, true]) {
        // Each iteration contributes 18*i + (flag ? 13 : 17).
        t.equal(plan.positionalBody(jit, 10, flag, thread), flag ? 940 : 980,
          'calls across budget boundaries preserve the result');
        t.equal(jvm.classes.RegionAdmission.staticFields.get('visits:I'), flag ? 20 : 10,
          'boundary side effects execute exactly once');
      }
    }
    t.end();
  });
}

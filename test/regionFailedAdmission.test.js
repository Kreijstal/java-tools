'use strict';
const test = require('tape');
const {JVM} = require('../src/core/jvm');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const compileFixture = makeJavaFixtureCompiler('region-failed-admission-');

for (const failure of ['lowering', 'positional-abi', 'asynchronous']) {
  for (const budget of ['methods', 'bytecode']) {
    test(`${failure} refusals consume the ${budget} admission allowance`, async t => {
      const classpath = compileFixture(t, 'FailedAdmission', `public class FailedAdmission {
        static int a(int x, boolean flag) { return x + (flag ? 1 : 2); }
        static int b(int x, boolean flag) { return x + (flag ? 3 : 4); }
        static int root(int x, boolean flag) { return a(x,flag) + b(x,flag) + a(x+1,flag); }
      }`);
      const jvm = new JVM({classpath, jit: {compileWorker:false, structuredSsa:true,
        hotCallGraphRegions:true, profileMethods:false}});
      const jit = jvm.jit, compiler = jit.hotCallGraphRegions;
      await jvm.loadClassByName('FailedAdmission');
      jvm.classInitializationState.set('FailedAdmission', 'INITIALIZED');
      const methods = {};
      for (const name of ['a', 'b', 'root']) {
        methods[name] = await jvm.findMethodInHierarchy('FailedAdmission', name, '(IZ)I');
        jit.getGeneratedFunction(methods[name]);
      }
      const allowance = jit.getCodeItems(methods.root).length + jit.getCodeItems(methods.a).length;
      if (budget === 'methods') compiler.maxMethods = 2;
      else compiler.maxCodeItems = allowance;
      const requested = [];
      const analysisRequests = [];
      const originalSync = jit.canCompileSynchronously;
      jit.canCompileSynchronously = function(method, ...args) {
        if (method === methods.a) {
          analysisRequests.push(method);
          if (failure === 'asynchronous') return false;
        }
        return originalSync.call(this, method, ...args);
      };
      const original = jit.getStructuredRegionCandidate;
      jit.getStructuredRegionCandidate = function(method, ...args) {
        requested.push(method.name);
        if (method === methods.a) {
          // Model both a failed lowering and a structured body that cannot
          // supply the scalar ABI required for a child of a region.
          return failure === 'lowering' ? null : {jvmStructuredSsa:true};
        }
        return original.call(this, method, ...args);
      };
      let plan;
      try { plan = jit.compileHotCallGraphRegion(methods.root); }
      finally {
        jit.getStructuredRegionCandidate = original;
        jit.canCompileSynchronously = originalSync;
      }
      t.equal(requested.filter(name => name === 'a').length, failure === 'asynchronous' ? 0 : 1,
        'a repeated rejected target is lowered only once');
      t.equal(analysisRequests.length, 1, 'a rejected target is analyzed only once');
      t.notOk(requested.includes('b'), 'rejected work still consumes the allowance');
      t.equal(plan?.attemptedMethods, 2, 'attempt count includes the rejected child');
      t.equal(plan?.attemptedCodeItems, allowance, 'attempted bytecode items include the rejected child');
      const reason = failure === 'asynchronous' ? 'asynchronous-target' :
        failure === 'lowering' ? 'uncompiled-structured-target' : 'target-without-positional-region-abi';
      t.equal(plan?.root.boundaries.filter(boundary => boundary.reason === reason).length, 2,
        'each call retains its own canonical boundary');
      t.notOk(plan?.backendEligible, 'a group with only its root is not published as a fused executable');
      const retried = jit.compileHotCallGraphRegion(methods.root);
      t.ok(retried?.backendEligible, 'a later compilation can retry a formerly rejected target');
      t.deepEqual(retried?.nodes.map(node => node.method.name), ['root','a'],
        'retry reserves the same bounded group');
      t.end();
    });
  }
}

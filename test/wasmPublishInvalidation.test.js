'use strict';

// docs/refactor.md 3.2: "Publication must update or invalidate all relevant
// cached entry paths so a warmed JS positional caller can reach a newly
// installed Wasm body."
//
// The mechanism exists (`JitCompiler.publishWasmTargetReady`, called from
// WasmJit the moment a module is installed). These tests pin the contract it
// implements, because the recorded obstacle in 3.2 is precisely a warmed
// `site.fastPositional` that keeps calling the superseded JavaScript child.

const test = require('tape');
const JitCompiler = require('../src/jit/JitCompiler');

function makeJit(readyMethods) {
  const jit = Object.create(JitCompiler.prototype);
  jit.generatedTargetsByMethod = new Map();
  jit.stableGeneratedEntries = new Map();
  jit.hotCallGraphRegions = null;
  jit.hasReadyFullWasm = (method) => readyMethods.has(method);
  jit.hasPreparedFullWasmUpgrade = () => false;
  return jit;
}

function makeSite(invoke, targetClassName) {
  const target = { positionalInvoker: invoke, targetClassName, generated: {} };
  const site = {
    fastPositional: { invoke },
    fastPositionalTargets: { [targetClassName]: { invoke } },
    fastDynamicTarget: { target, positional: { invoke } },
  };
  return { site, target };
}

test('publishing a wasm body clears every warmed positional entry path', (t) => {
  const method = { name: 'callee', descriptor: '(I)I' };
  const jit = makeJit(new Set([method]));
  const invoke = function warmedJsChild() {};
  const { site, target } = makeSite(invoke, 'Owner');
  jit.generatedTargetsByMethod.set(method, [{ target, site }]);

  jit.publishWasmTargetReady(method);

  t.equal(site.fastPositional, null,
    'the monomorphic positional slot is dropped');
  t.equal(site.fastPositionalTargets.Owner, undefined,
    'the per-receiver positional entry is dropped');
  t.equal(site.fastDynamicTarget.positional, null,
    'the dynamic target stops offering the superseded positional invoker');
  t.equal(target.positionalInvoker, undefined,
    'and the target no longer names it, so it cannot be re-cached');
  t.end();
});

test('a positional entry belonging to a different invoker is left alone', (t) => {
  // The slot is keyed by identity for a reason: two targets can share a site,
  // and clearing another target's warmed entry would deoptimize a caller that
  // has nothing to do with this publication.
  const method = { name: 'callee', descriptor: '(I)I' };
  const jit = makeJit(new Set([method]));
  const invoke = function warmedJsChild() {};
  const { site, target } = makeSite(invoke, 'Owner');
  const foreign = { invoke: function someoneElse() {} };
  site.fastPositional = foreign;
  site.fastPositionalTargets.Owner = foreign;
  jit.generatedTargetsByMethod.set(method, [{ target, site }]);

  jit.publishWasmTargetReady(method);

  t.equal(site.fastPositional, foreign,
    'another invoker keeps its monomorphic slot');
  t.equal(site.fastPositionalTargets.Owner, foreign,
    'and its per-receiver entry');
  t.end();
});

test('publication with no ready wasm body invalidates nothing', (t) => {
  const method = { name: 'callee', descriptor: '(I)I' };
  const jit = makeJit(new Set());
  const invoke = function warmedJsChild() {};
  const { site, target } = makeSite(invoke, 'Owner');
  const slotBefore = site.fastPositional;
  const perReceiverBefore = site.fastPositionalTargets.Owner;
  jit.generatedTargetsByMethod.set(method, [{ target, site }]);

  jit.publishWasmTargetReady(method);

  t.equal(site.fastPositional, slotBefore,
    'the monomorphic slot is the same object it was before');
  t.equal(site.fastPositionalTargets.Owner, perReceiverBefore,
    'and so is the per-receiver entry');
  t.ok(site.fastPositional && site.fastPositional.invoke === invoke,
    'the warmed entry survives, because there is nothing to replace it with');
  t.equal(target.positionalInvoker, invoke, 'and the target still names it');
  t.end();
});

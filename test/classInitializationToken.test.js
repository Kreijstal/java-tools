'use strict';
const test = require('tape');
const {JVM} = require('../src/core/jvm');
const ClassInitializationToken = require('../src/core/ClassInitializationToken');

test('Wasm readiness follows live class state and preserves token identity', t => {
  const j = new JVM({jit:{compileWorker:false}});
  const token = j.getClassInitializationToken('Probe');
  const guard = token.wasmReadinessGuard();
  t.equal(guard(), 0, 'uninitialized class stays cold');
  t.equal(token.wasmReadinessGuard(), guard, 'one Wasm getter per token');
  for (const state of ['INITIALIZING','INITIALIZED','ERRONEOUS','INITIALIZED']) {
    j.classInitializationState.set('Probe', state);
    t.equal(guard(), state === 'INITIALIZED' ? 1 : 0, state + ' is visible to existing guard');
    t.equal(token.initialized, state === 'INITIALIZED', 'JavaScript agrees with Wasm');
  }
  j.classInitializationState.delete('Probe');
  t.equal(guard(), 0, 'deletion invalidates existing guard');
  j._setClassInitializationState('Probe', 'INITIALIZED');
  t.equal(guard(), 1, 'internal state update publishes readiness');
  j.classInitializationState.clear();
  t.equal(guard(), 0, 'clear invalidates existing guard');
  token.initialized = true;
  t.equal(guard(), 1, 'direct token assignment remains supported');
  j._refreshClassInitializationTokens();
  t.equal(guard(), 0, 'state refresh updates existing guard');
  t.equal(j.getClassInitializationToken('Probe'), token, 'token identity survives state transitions');
  const warm = new ClassInitializationToken('INITIALIZED');
  t.equal(warm.wasmReadinessGuard()(), 1, 'lazy Wasm creation captures current readiness');
  warm.initialized = false;
  t.equal(warm.wasmReadinessGuard()(), 0, 'independent token can be reset');
  t.equal(guard(), 0, 'tokens do not share mutable flags');
  t.end();
});

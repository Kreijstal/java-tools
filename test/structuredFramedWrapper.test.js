'use strict';
const test = require('tape');
const {structuredWrappers: {wrapFramedStructuredBody}} = require('../src/jit/JvmSsaBlockRenderer');
const {STRUCTURED_CONTINUATION: key} = require('../src/core/constants');

test('canonical framed entry preserves adaptive arguments and continuation ownership', t => {
  const frame = {pc: 0, stack: {itemCount: 2}}, thread = {callStack: {peek: () => frame, pop: () => { pops++; }}};
  let pops = 0, adaptiveCalls = 0, nextCalls = 0, returns = 0;
  const helpers = {needsBytecodeChecks: () => false, skipJitOnce: () => { skipped++; },
    structuredSsa: {continuationPcMismatchCount: 0}};
  let skipped = 0;
  const value = {}, state = {guardedStaticBooleanStateMatches: () => true,
    fieldBackedArrayStateMatches: () => true, captureFieldBackedArrayState: () => null};
  const body = wrapFramedStructuredBody(() => { throw new Error('unexpected new generator'); }, state, {
    itemCount: 20, ordinaryAdaptiveCanonical: true,
    adaptivePositionalBody: (...args) => { adaptiveCalls++; t.deepEqual(args, [frame, thread, helpers, false, false], 'adaptive argument protocol'); return value; },
  });
  t.equal(body(frame, thread, helpers, false), value, 'fresh entry returns adaptive result unchanged');
  const iterator = {next: () => { nextCalls++; return {done: false, value: {structuredResumePc: 3}}; }, return: () => { returns++; }};
  frame.pc = 3; frame[key] = {iterator, pc: 3, framelessEntry: true};
  body(frame, thread, helpers, false);
  t.equal(nextCalls, 1, 'existing iterator resumes');
  t.equal(adaptiveCalls, 1, 'resume does not replay fresh entry');
  t.ok(frame[key].framelessEntry, 'origin survives another yield');
  iterator.next = () => ({done: true, value: 42});
  t.deepEqual(body(frame, thread, helpers, false), {returned: true, value: 42}, 'restored frameless return completes canonical frame');
  t.equal(pops, 1, 'frame popped exactly once');
  t.equal(frame.stack.itemCount, 0, 'operands retired');
  t.equal(frame.pc, 20, 'completed pc retained');
  t.equal(frame[key], undefined, 'completed iterator released');
  frame.pc = 4; frame[key] = {iterator, pc: 3};
  t.ok(body(frame, thread, helpers, false).deopt, 'mismatched continuation deoptimizes');
  t.equal(returns, 1, 'invalid iterator closed');
  t.equal(skipped, 1, 'interpreter resume requested');
  t.equal(frame[key], undefined, 'invalid continuation released');
  t.end();
});

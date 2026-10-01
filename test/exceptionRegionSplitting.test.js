'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {splitIrreducibleTerms} = require('../src/decompiler/exceptionStructurer');
const {structure, succOfTerm, succAllOfTerm, IrreducibleError} = require('../src/decompiler/structurer');

// One entry to the outer loop hides multiple entries to nested cycles. This
// small graph retains the problematic joins without any game-specific names.
const nested = [
  {kind: 'cond', taken: 1, fall: 6},
  {kind: 'cond', taken: 9, fall: 2},
  {kind: 'cond', taken: 9, fall: 3},
  {kind: 'fall', target: 4},
  {kind: 'cond', taken: 8, fall: 5},
  {kind: 'fall', target: 6},
  {kind: 'cond', taken: 10, fall: 7},
  {kind: 'cond', taken: 4, fall: 8},
  {kind: 'cond', taken: 1, fall: 9},
  {kind: 'goto', target: 0},
  {kind: 'return'},
];
function cfg(terms) {
  return {n: terms.length, entry: 0, term: terms,
    succ: terms.map(succOfTerm), succAll: terms.map(succAllOfTerm)};
}
function trace(terms, origins, seed) {
  const visited = [];
  let node = 0;
  for (let step = 0; step < 400; step++) {
    visited.push(origins[node]);
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const term = terms[node];
    if (term.kind === 'return') return {visited, returned: true};
    if (term.kind === 'cond') node = seed & 0x100 ? term.taken : term.fall;
    else if (term.kind === 'switch') {
      node = term.cases.find(item => item.key === (seed % 4))?.target ?? term.default;
    } else node = term.target;
  }
  return {visited, returned: false};
}

test('nested cycles split deterministically and preserve every routed path', () => {
  assert.throws(() => structure(cfg(nested)), IrreducibleError);
  const original = JSON.stringify(nested);
  const split = splitIrreducibleTerms(nested, 0);
  assert.ok(split);
  assert.equal(split.terms.length, 24);
  assert.equal(JSON.stringify(nested), original);
  assert.deepEqual(splitIrreducibleTerms(nested, 0), split);
  assert.doesNotThrow(() => structure(cfg(split.terms)));
  for (let seed = 0; seed < 256; seed++)
    assert.deepEqual(trace(split.terms, split.origins, seed),
      trace(nested, nested.map((_, id) => id), seed));
});

test('nested splitting refuses exhausted size and round budgets without partial results', () => {
  const original = JSON.stringify(nested);
  assert.equal(splitIrreducibleTerms(nested, 0, {maxTerms: 23}), null);
  assert.equal(splitIrreducibleTerms(nested, 0, {maxRounds: 1}), null);
  assert.ok(splitIrreducibleTerms(nested, 0, {maxTerms: 24, maxRounds: 2}));
  assert.equal(JSON.stringify(nested), original);
});

test('switch defaults and duplicate targets survive splitting; unreachable entries do not count', () => {
  const terms = nested.map(term => ({...term}));
  terms[0] = {kind: 'switch', cases: [{key: 0, target: 1}, {key: 1, target: 1},
    {key: 2, target: 6}], default: 6};
  terms.push({kind: 'goto', target: 4}); // unreachable predecessor
  const split = splitIrreducibleTerms(terms, 0);
  assert.ok(split);
  assert.doesNotThrow(() => structure(cfg(split.terms)));
  for (let seed = 0; seed < 256; seed++)
    assert.deepEqual(trace(split.terms, split.origins, seed),
      trace(terms, terms.map((_, id) => id), seed));
  const reducible = [{kind: 'fall', target: 1}, {kind: 'cond', taken: 0, fall: 2},
    {kind: 'return'}, {kind: 'goto', target: 1}];
  assert.equal(splitIrreducibleTerms(reducible, 0), null);
});

test('already reducible deep cycles need neither copies nor recursive traversal', () => {
  const terms = Array.from({length: 5000}, (_, node) =>
    ({kind: 'goto', target: (node + 1) % 5000}));
  assert.equal(splitIrreducibleTerms(terms, 0), null);
});

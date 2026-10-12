'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {splitIrreducibleTerms} = require('../src/decompiler/exceptionStructurer');
const {structure, succOfTerm, succAllOfTerm, IrreducibleError} = require('../src/decompiler/structurer');
const {verifyStructuredFlow} = require('../src/decompiler/structuredFlowVerifier');

const loop = [
  {kind: 'cond', taken: 1, fall: 2},
  {kind: 'cond', taken: 3, fall: 5},
  {kind: 'cond', taken: 4, fall: 6},
  {kind: 'goto', target: 2},
  {kind: 'goto', target: 1},
  {kind: 'goto', target: 6},
  {kind: 'return'},
];
const switched = loop.map(term => structuredClone(term));
switched[0] = {kind: 'switch', cases: [{key: -1, target: 1},
  {key: 7, target: 2}, {key: 9, target: 1}], default: 2};

const cfg = terms => ({n: terms.length, entry: 0, term: terms,
  succ: terms.map(succOfTerm), succAll: terms.map(succAllOfTerm)});

// A finite local simulation certificate: every copy executes the same source
// block and has the same successor for EACH outcome, not sampled outcomes.
// Induction on steps gives equality of every finite action/test trace. The
// same relation carries divergent runs; actions may mutate state or throw.
// This proves control flow only: it assumes block actions/tests stay unchanged.
function proveCopies(source, split) {
  assert.equal(split.origins[0], 0);
  assert.equal(split.origins.length, split.terms.length);
  for (let copy = 0; copy < split.terms.length; copy++) {
    const original = source[split.origins[copy]], candidate = split.terms[copy];
    assert.ok(original);
    assert.equal(candidate.kind, original.kind);
    const target = id => {assert.ok(Number.isSafeInteger(id));return split.origins[id];};
    if (original.kind === 'cond') {
      assert.equal(target(candidate.taken), original.taken);
      assert.equal(target(candidate.fall), original.fall);
    } else if (original.kind === 'switch') {
      assert.deepEqual(candidate.cases.map(item => ({key: item.key, target: target(item.target)})), original.cases);
      assert.equal(candidate.default == null ? candidate.default : target(candidate.default), original.default);
    } else if (original.kind !== 'return') {
      assert.equal(target(candidate.target), original.target);
    }
  }
}

function sourceTree(terms, origins) {
  const tree = structure(cfg(terms)).tree;
  function walk(node) {
    if (!node) return;
    if (['straight', 'if', 'switch'].includes(node.t)) node.block = origins[node.block];
    if (Array.isArray(node.body)) node.body.forEach(walk); else walk(node.body);
    walk(node.then);walk(node.els);walk(node.dflt);
    for (const item of node.cases || []) walk(item.body);
  }
  walk(tree);
  return tree;
}

for (const [name, terms] of [['two loop entrances', loop], ['switch/default loop entrances', switched]]) {
  test(name + ': complete copy certificate and independent structured-edge proof', () => {
    assert.throws(() => structure(cfg(terms)), IrreducibleError);
    const split = splitIrreducibleTerms(terms, 0);
    assert.ok(split);
    proveCopies(terms, split);
    const flow = {entry: 0, blocks: terms.map((term, block) => ({block, term}))};
    assert.equal(verifyStructuredFlow(sourceTree(split.terms, split.origins), flow), true);
    const broken = structuredClone(split);
    const copy = broken.origins.findIndex((origin, id) => id >= terms.length && origin === 1);
    assert.ok(copy >= 0);
    [broken.terms[copy].taken, broken.terms[copy].fall] =
      [broken.terms[copy].fall, broken.terms[copy].taken];
    assert.throws(() => proveCopies(terms, broken), assert.AssertionError);
    assert.equal(verifyStructuredFlow(sourceTree(broken.terms, broken.origins), flow), false);
  });
}

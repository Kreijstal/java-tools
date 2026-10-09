'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {structure, succOfTerm, succAllOfTerm, uniquifyLabels} = require('../src/decompiler/structurer');
const {verifyStructuredFlow} = require('../src/decompiler/structuredFlowVerifier');

const flowOf = terms => ({entry: 0, blocks: terms.map((term, block) => ({block, term}))});
function treeOf(term) {
  return structure({n: term.length, entry: 0, term,
    succ: term.map(succOfTerm), succAll: term.map(succAllOfTerm)}).tree;
}

test('source-edge verification preserves nested loops, switches, joins and dead blocks', () => {
  const fixtures = [
    [{kind: 'return'}],
    [{kind: 'cond', taken: 0, fall: 1}, {kind: 'return'}],
    [{kind: 'goto', target: 1}, {kind: 'cond', taken: 2, fall: 4},
      {kind: 'cond', taken: 1, fall: 3}, {kind: 'goto', target: 0}, {kind: 'return'}],
    [{kind: 'switch', cases: [{key: -1, target: 1}, {key: 4, target: 2}], default: 3},
      {kind: 'goto', target: 4}, {kind: 'goto', target: 4},
      {kind: 'goto', target: 4}, {kind: 'return'}, {kind: 'return'}],
  ];
  for (const terms of fixtures) {
    const tree = treeOf(terms);
    assert.equal(verifyStructuredFlow(tree, flowOf(terms)), true);
    uniquifyLabels(tree);
    assert.equal(verifyStructuredFlow(tree, flowOf(terms)), true);
  }
});

test('wrong enclosing-loop destinations are refused even when labels are valid', () => {
  const flow = flowOf([{kind: 'goto', target: 1}, {kind: 'goto', target: 0}]);
  const jump = {t: 'continue', label: 'Outer'};
  const tree = {t: 'loop', label: 'Outer', body: {t: 'seq', body: [
    {t: 'straight', block: 0},
    {t: 'loop', label: 'Inner', body: {t: 'seq', body: [{t: 'straight', block: 1}, jump]}},
  ]}};
  assert.equal(verifyStructuredFlow(tree, flow), true);
  jump.label = 'Inner';
  assert.equal(verifyStructuredFlow(tree, flow), false);
});

test('branch polarity, switch keys and targets remain source-identical', () => {
  const terms = [{kind: 'cond', taken: 1, fall: 2}, {kind: 'return'}, {kind: 'return'}];
  const tree = treeOf(terms);
  const branch = tree.body.find(node => node.t === 'if');
  [branch.then, branch.els] = [branch.els, branch.then];
  assert.equal(verifyStructuredFlow(tree, flowOf(terms)), false);
  const switched = [{kind: 'switch', cases: [{key: 1, target: 1}, {key: 2, target: 2}], default: 3},
    {kind: 'return'}, {kind: 'return'}, {kind: 'return'}];
  for (const mutate of [
    node => { node.cases[0].key = 2; },
    node => { [node.cases[0].body, node.cases[1].body] = [node.cases[1].body, node.cases[0].body]; },
    node => { node.dflt = null; },
  ]) {
    const candidate = treeOf(switched);
    mutate(candidate.body.find(node => node.t === 'switch'));
    assert.equal(verifyStructuredFlow(candidate, flowOf(switched)), false);
  }
});

test('unknown nodes, missing entries and empty infinite loops cannot stand in for source blocks', () => {
  const flow = flowOf([{kind: 'return'}]);
  for (const tree of [{t: 'seq', body: []}, {t: 'regionExit', label: 'Loop', mode: 'break'},
    {t: 'try', body: {t: 'straight', block: 0}, catches: []},
    {t: 'loop', label: 'Loop', body: {t: 'seq', body: []}}])
    assert.equal(verifyStructuredFlow(tree, flow), false);
});

test('every controlled copy must keep the original edges', () => {
  const flow = flowOf([{kind: 'cond', taken: 1, fall: 1},
    {kind: 'goto', target: 2}, {kind: 'return'}]);
  const copy = () => ({t: 'seq', body: [{t: 'straight', block: 1}, {t: 'straight', block: 2}]});
  const branch = {t: 'if', block: 0, then: copy(), els: copy()};
  const tree = {t: 'seq', body: [{t: 'straight', block: 0}, branch]};
  assert.equal(verifyStructuredFlow(tree, flow), true);
  branch.then.body.pop();
  assert.equal(verifyStructuredFlow(tree, flow), false);
});

test('switch cases that lose their exits fall into the next Java case', () => {
  const flow = flowOf([{kind: 'switch', cases: [{key: 1, target: 3}, {key: 2, target: 2}], default: 3},
    {kind: 'return'}, {kind: 'goto', target: 3}, {kind: 'return'}]);
  const jump = () => ({t: 'break', label: 'Join'});
  const switched = {t: 'switch', block: 0, cases: [
    {key: 1, body: jump()},
    {key: 2, body: {t: 'seq', body: [{t: 'straight', block: 2}, jump()]}},
  ], dflt: jump()};
  const tree = {t: 'seq', body: [
    {t: 'block', label: 'Join', body: {t: 'seq', body: [{t: 'straight', block: 0}, switched]}},
    {t: 'straight', block: 3},
  ]};
  assert.equal(verifyStructuredFlow(tree, flow), true);
  switched.cases[0].body = {t: 'seq', body: []};
  assert.equal(verifyStructuredFlow(tree, flow), false);
});

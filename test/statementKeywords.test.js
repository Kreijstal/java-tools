'use strict';
const test = require('tape');
const {skeletonKeywordPositions, skeletonCodeMask, partsRelocationHostile,
  partsCarriesNestedFunction} = require('../src/jit/statementParts');

test('statement keyword searches preserve lexical boundaries and exclusions', t => {
  const cases = [
    ['', 'await', []],
    ['local0 = local1 + 2;', 'await', []],
    ['awaiting await$ _await $await await2', 'await', []],
    ['await call(); await other();', 'await', [0, 14]],
    ['"await"; await call();', 'await', [9]],
    ["'await'; await call();", 'await', [9]],
    ['`await`; await call();', 'await', [9]],
    ['/* await */ await call(); // await', 'await', [12]],
    ['// await', 'await', []],
    ['functionality(function () {})', 'function', [14]],
  ];
  for (const [source, keyword, expected] of cases) {
    t.deepEqual(skeletonKeywordPositions(source, keyword), expected, source || 'empty statement');
    t.deepEqual(skeletonKeywordPositions(source, keyword, skeletonCodeMask(source)),
      expected, 'explicit mask gives the same positions');
  }
  t.notOk(partsRelocationHostile(['local0 = awaiting + argumentsCount;']),
    'identifier substrings do not prohibit relocation');
  t.notOk(partsRelocationHostile(['"await this arguments"; /* var eval */']),
    'literals and comments do not prohibit relocation');
  t.ok(partsRelocationHostile(['local0 = await work();']), 'real await prohibits relocation');
  t.notOk(partsCarriesNestedFunction(['"function"; functionality();']),
    'function text in a literal or identifier is not a nested declaration');
  t.ok(partsCarriesNestedFunction(['function child() {}']), 'nested function is detected');
  t.end();
});

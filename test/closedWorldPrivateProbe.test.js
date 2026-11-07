'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compileFixture, hotspot, runDetailed, jspiNode } = require('./helpers/closedWorld');

// Class.newInstance() on a private constructor from another class throws
// IllegalAccessException without running it, on every tier.
for (const [label, options] of [['bytecode tiers', { closedWorld: false }], ['closed world', { closedWorld: true, jspiNode: true }]]) {
  test(`a private constructor is refused to reflection from another class (${label})`,
    { skip: options.jspiNode && !jspiNode() ? 'no Node with JSPI' : false }, () => {
      const directory = compileFixture('ClosedPrivateProbe');
      const expected = hotspot(directory, 'ClosedPrivateProbe');
      assert.equal(expected, 'java.lang.IllegalAccessException\nClosedPrivateProbe$Open\nstill running\n');
      const result = runDetailed(directory, 'ClosedPrivateProbe', options);
      assert.equal(result.failure, null, result.stderr);
      assert.equal(result.output, expected);
    });
}

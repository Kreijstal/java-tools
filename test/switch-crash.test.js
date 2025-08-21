const test = require('tape');
const path = require('path');
const { runTest } = require('./test-helpers.js');

test('JVM Crash Tests - SwitchCrash', t => {
    t.plan(1);
    const expectedOutput = 'Testing tableswitch:\nCase 0\nCase 1\nCase 2\nDefault case\n\nTesting lookupswitch:\nCase 10\n2\n4\nCase 100\n2\n4\nCase 1000\n2\n4\nDefault case\n2\n4\n';
    runTest('SwitchCrash', expectedOutput, t);
});

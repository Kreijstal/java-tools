const { runTest } = require('./test-helpers.js');
const test = require('tape');

test('ArithmeticTest.java - all operations', async (t) => {
    const expectedOutput = 'Integer Arithmetic:\nSum: 13\nDifference: 7\nProduct: 30\nQuotient: 3\nRemainder: 1\n\nDouble Arithmetic:\nSum: 22222.2221\nDifference: 2469.1357000000007\nProduct: 1.219326309891785E8\nQuotient: 1.249999989875\n\nFloat Arithmetic:\nSum: 16.0\nDifference: 9.0\nProduct: 43.75\nQuotient: 3.5714285373687744\n';
    const result = await runTest('ArithmeticTest', expectedOutput, t, {});
    t.equal(result.output, expectedOutput, 'ArithmeticTest should correctly perform all operations');
    t.end();
});

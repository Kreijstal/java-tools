const { runTest } = require('./test/test-helpers');

async function testInteger() {
    console.log('Testing Integer...');
    const result = await runTest('ArithmeticComparisons', '', null);
    console.log('Integer test output:', result.output);
    console.log('Integer test success:', result.success);
    if (result.error) {
        console.error('Integer test error:', result.error);
    }
}

testInteger().catch(console.error);
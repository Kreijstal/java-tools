const { runTest } = require('./test/test-helpers');

async function testCRC32Simple() {
    console.log('Testing CRC32 Simple...');
    const result = await runTest('CRC32SimpleTest', 'CRC32 created\nCRC32 reset', null);
    console.log('CRC32 simple test output:', result.output);
    console.log('CRC32 simple test success:', result.success);
    if (result.error) {
        console.error('CRC32 simple test error:', result.error);
    }
}

testCRC32Simple().catch(console.error);
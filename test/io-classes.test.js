const test = require('tape');
const { runTest } = require('./test-helpers');

test('IO classes functionality test', async (t) => {
const expectedOutput = `=== IO Classes Test ===
Testing ByteArrayInputStream:
Read byte: 65
Read byte: 66
Read byte: 67
Read byte: 68
Available: 0
Testing StringWriter:
StringWriter content: Hello
Testing StringReader:
Read char: 84
Read char: 101
Read char: 115
Read char: 116
Testing File:
File exists: false
File path: test.txt
Testing IOException:
Caught: java.io.IOException: Test exception
=== Test Complete ===`;

  await runTest('IOTest', expectedOutput, t);
});
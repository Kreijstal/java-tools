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
Testing File:
File exists: false
File path: 
Testing IOException:
Caught: java.io.IOException
=== Test Complete ===`;

  await runTest('IOTest', expectedOutput, t);
});
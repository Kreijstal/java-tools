const test = require('tape');
const { runTest } = require('./test-helpers');

test('IO classes functionality test', async (t) => {
const expectedOutput = `=== IO Classes Test ===
Testing ByteArrayInputStream:
Read byte: 65 (A)
Read byte: 66 (B)
Read byte: 67 (C)
Read byte: 68 (D)
Testing StringWriter:
StringWriter content: Hello
=== Test Complete ===`;

  await runTest('IOTest', expectedOutput, t);
});
const test = require('tape');
const { runTest } = require('./test-helpers');

test('Implemented IO classes functionality test', async (t) => {
  const expectedOutput = `--- IO Implementation Test ---
BufferedReader line 1: Hello
BufferedReader line 2: World
DataInputStream read: 0,1,2,3
RandomAccessFile read: 123
RandomAccessFile length: 1
PrintWriter output: Hello from PrintWriter
--- Test Complete ---`;

  await runTest('IOImplTest', expectedOutput, t);
});

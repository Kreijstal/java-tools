const { runTest } = require("./test-helpers.js");
const test = require("tape");

test("Random with seed consistency", async (t) => {
  const expectedOutput = `nextInt(): -1155484576\nnextInt(100): 48\nnextBoolean(): false`;

  const result = await runTest("RandomSeedTest", expectedOutput, t);

  t.equal(
    result.output.trim(),
    expectedOutput.trim(),
    "Random should produce consistent results with seed 0"
  );
  t.ok(result.success, "Test should complete successfully");
  t.end();
});

test("Random comprehensive functionality", async (t) => {
  // Just test that all methods work without errors - values will vary due to timing
  const result = await runTest("RandomTest", undefined, t);

  t.ok(result.success, "Random test should complete successfully");
  
  // Verify output has the expected structure (7 lines)
  const lines = result.output.split('\n').filter(line => line.trim());
  t.equal(lines.length, 7, "Should have 7 lines of output (6 values + byte array)");
  
  // Verify first line is an integer
  const firstInt = parseInt(lines[0]);
  t.ok(Number.isInteger(firstInt), "First line should be an integer");
  
  // Verify second line is bounded integer (0-99)
  const boundedInt = parseInt(lines[1]);
  t.ok(boundedInt >= 0 && boundedInt < 100, "Second line should be 0-99");
  
  // Verify third line is a long (BigInt-like number)
  const longVal = lines[2];
  t.ok(/^-?\d+$/.test(longVal), "Third line should be a long number");
  
  // Verify fourth line is boolean
  t.ok(lines[3] === 'true' || lines[3] === 'false', "Fourth line should be boolean");
  
  // Verify fifth line is float
  const floatVal = parseFloat(lines[4]);
  t.ok(!isNaN(floatVal) && floatVal >= 0 && floatVal < 1, "Fifth line should be float [0,1)");
  
  // Verify sixth line is double
  const doubleVal = parseFloat(lines[5]);
  t.ok(!isNaN(doubleVal), "Sixth line should be a double");
  
  // Verify seventh line is byte array (space-separated integers)
  const byteArray = lines[6].trim().split(' ').filter(s => s);
  t.equal(byteArray.length, 10, "Should have 10 bytes");
  byteArray.forEach(byteStr => {
    const byteVal = parseInt(byteStr);
    t.ok(byteVal >= -128 && byteVal <= 127, "Each byte should be in range [-128, 127]");
  });
  
  t.end();
});
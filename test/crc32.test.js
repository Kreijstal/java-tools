const { runTest } = require("./test-helpers.js");
const test = require("tape");

test("CRC32 basic functionality", async (t) => {
  const expectedOutput = `Test passed`;

  const result = await runTest("CRC32Test", expectedOutput, t);

  t.equal(
    result.output.trim(),
    expectedOutput.trim(),
    "CRC32 should calculate correct checksum for 'Hello, World!'"
  );
  t.ok(result.success, "Test should complete successfully");
  t.end();
});

test("CRC32 step by step operations", async (t) => {
  const expectedOutput = `CRC32 created\nCRC32 updated\nValue: 4157704578`;

  const result = await runTest("CRC32GetValueTest", expectedOutput, t);

  t.equal(
    result.output.trim(),
    expectedOutput.trim(),
    "CRC32 should work with step-by-step operations"
  );
  t.ok(result.success, "Test should complete successfully");
  t.end();
});

test("CRC32 reset functionality", async (t) => {
  const expectedOutput = `CRC32 created\nCRC32 reset`;

  const result = await runTest("CRC32SimpleTest", expectedOutput, t);

  t.equal(
    result.output.trim(),
    expectedOutput.trim(),
    "CRC32 should support reset operations"
  );
  t.ok(result.success, "Test should complete successfully");
  t.end();
});
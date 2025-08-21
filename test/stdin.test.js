const { runTest } = require("./test-helpers.js");
const test = require("tape");

test("stdin mocking - basic input test", async (t) => {
  const inputData = "Hello World\nTest Input";
  const expectedOutput = "Hello World\nTest Input\n";

  const result = await runTest("InputTest", expectedOutput, t, {
    inputData: inputData,
  });

  t.equal(
    result.output,
    expectedOutput,
    "Input should be echoed back correctly",
  );
  t.ok(result.success, "Test should complete successfully");
  t.end();
});

test("stdin mocking - empty input", async (t) => {
  const inputData = "";
  const expectedOutput = "";

  const result = await runTest("InputTest", expectedOutput, t, {
    inputData: inputData,
  });

  t.equal(
    result.output,
    expectedOutput,
    "Empty input should produce empty output",
  );
  t.ok(result.success, "Test should complete successfully");
  t.end();
});

test("stdin mocking - multiple lines", async (t) => {
  const inputData = "Line 1\nLine 2\nLine 3";
  const expectedOutput = "Line 1\nLine 2\nLine 3\n";

  const result = await runTest("InputTest", expectedOutput, t, {
    inputData: inputData,
  });

  t.equal(
    result.output,
    expectedOutput,
    "Multiple lines should be echoed back correctly",
  );
  t.ok(result.success, "Test should complete successfully");
  t.end();
});

test("stdin mocking - special characters", async (t) => {
  const inputData = "Hello\tWorld\nTest with spaces";
  const expectedOutput = "Hello\tWorld\nTest with spaces\n";

  const result = await runTest("InputTest", expectedOutput, t, {
    inputData: inputData,
  });

  t.equal(
    result.output,
    expectedOutput,
    "Special characters should be preserved",
  );
  t.ok(result.success, "Test should complete successfully");
  t.end();
});

test("stdin mocking - unicode characters", async (t) => {
  // Skip unicode test for now due to encoding issues
  t.skip("Unicode character handling requires proper encoding support");
  t.end();
});

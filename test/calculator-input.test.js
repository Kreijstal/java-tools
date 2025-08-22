const { runTest } = require("./test-helpers.js");
const test = require("tape");

test("calculator with stdin - basic operations", async (t) => {
  const inputData = "5 + 3\n10 - 2\n4 * 6\n8 / 2\nexit\n";
  const expectedOutput = `Simple Calculator (type 'exit' to quit)
Enter operations in format: number operator number
Example: 5 + 3
> Result: 8.0
> Result: 8.0
> Result: 24.0
> Result: 4.0
> Calculator exited
`;

  const result = await runTest("CalculatorInput", expectedOutput, t, {
    inputData: inputData,
  });

  t.equal(
    result.output,
    expectedOutput,
    "Calculator should process operations correctly",
  );
  t.ok(result.success, "Test should complete successfully");
  t.end();
});

test("calculator with stdin - division by zero", async (t) => {
  const inputData = "10 / 0\nexit\n";
  const expectedOutput = `Simple Calculator (type 'exit' to quit)
Enter operations in format: number operator number
Example: 5 + 3
> Error: Division by zero
> Calculator exited
`;

  const result = await runTest("CalculatorInput", expectedOutput, t, {
    inputData: inputData,
  });

  t.equal(
    result.output,
    expectedOutput,
    "Calculator should handle division by zero",
  );
  t.ok(result.success, "Test should complete successfully");
  t.end();
});

test("calculator with stdin - invalid input", async (t) => {
  const inputData = "invalid\n5 + 3 + 2\n5 ? 3\nexit\n";
  const expectedOutput = `Simple Calculator (type 'exit' to quit)
Enter operations in format: number operator number
Example: 5 + 3
> Error: Please use format: number operator number
> Error: Please use format: number operator number
> Error: Unknown operator '?'
Supported operators: +, -, *, /
> Calculator exited
`;

  const result = await runTest("CalculatorInput", expectedOutput, t, {
    inputData: inputData,
  });

  t.equal(
    result.output,
    expectedOutput,
    "Calculator should handle invalid input gracefully",
  );
  t.ok(result.success, "Test should complete successfully");
  t.end();
});

test("calculator with stdin - decimal numbers", async (t) => {
  const inputData = "3.5 + 2.5\n7.2 * 2\nexit\n";
  const expectedOutput = `Simple Calculator (type 'exit' to quit)
Enter operations in format: number operator number
Example: 5 + 3
> Result: 6.0
> Result: 14.4
> Calculator exited
`;

  const result = await runTest("CalculatorInput", expectedOutput, t, {
    inputData: inputData,
  });

  t.equal(
    result.output,
    expectedOutput,
    "Calculator should handle decimal numbers",
  );
  t.ok(result.success, "Test should complete successfully");
  t.end();
});

test("calculator with stdin - empty input and exit", async (t) => {
  const inputData = "\n\n5 + 3\n\nexit\n";
  const expectedOutput = `Simple Calculator (type 'exit' to quit)
Enter operations in format: number operator number
Example: 5 + 3
> > > Result: 8.0
> > Calculator exited
`;

  const result = await runTest("CalculatorInput", expectedOutput, t, {
    inputData: inputData,
  });

  t.equal(
    result.output,
    expectedOutput,
    "Calculator should handle empty lines correctly",
  );
  t.ok(result.success, "Test should complete successfully");
  t.end();
});

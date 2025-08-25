const { runTest } = require('./test-helpers.js');
const test = require('tape');

test('Calculator.java - addition', async (t) => {
    const inputData = '5 + 3\nexit';
    const expectedOutput = 'Simple Calculator (type \'exit\' to quit)\nEnter operations in format: number operator number\nExample: 5 + 3\n> Result: 8.0\n> Calculator exited\n';
    const result = await runTest('Calculator', expectedOutput, t, { inputData });
    t.equal(result.output, expectedOutput, 'Calculator should correctly add two numbers');
    t.end();
});

test('Calculator.java - subtraction', async (t) => {
    const inputData = '10 - 4\nexit';
    const expectedOutput = 'Simple Calculator (type \'exit\' to quit)\nEnter operations in format: number operator number\nExample: 5 + 3\n> Result: 6.0\n> Calculator exited\n';
    const result = await runTest('Calculator', expectedOutput, t, { inputData });
    t.equal(result.output, expectedOutput, 'Calculator should correctly subtract two numbers');
    t.end();
});

test('Calculator.java - multiplication', async (t) => {
    const inputData = '6 * 7\nexit';
    const expectedOutput = 'Simple Calculator (type \'exit\' to quit)\nEnter operations in format: number operator number\nExample: 5 + 3\n> Result: 42.0\n> Calculator exited\n';
    const result = await runTest('Calculator', expectedOutput, t, { inputData });
    t.equal(result.output, expectedOutput, 'Calculator should correctly multiply two numbers');
    t.end();
});

test('Calculator.java - division', async (t) => {
    const inputData = '20 / 5\nexit';
    const expectedOutput = 'Simple Calculator (type \'exit\' to quit)\nEnter operations in format: number operator number\nExample: 5 + 3\n> Result: 4.0\n> Calculator exited\n';
    const result = await runTest('Calculator', expectedOutput, t, { inputData });
    t.equal(result.output, expectedOutput, 'Calculator should correctly divide two numbers');
    t.end();
});

test('Calculator.java - division by zero', async (t) => {
    const inputData = '10 / 0\nexit';
    const expectedOutput = 'Simple Calculator (type \'exit\' to quit)\nEnter operations in format: number operator number\nExample: 5 + 3\n> Error: Division by zero\n> Calculator exited\n';
    const result = await runTest('Calculator', expectedOutput, t, { inputData });
    t.equal(result.output, expectedOutput, 'Calculator should handle division by zero');
    t.end();
});

test('Calculator.java - invalid input', async (t) => {
    const inputData = 'invalid input\nexit';
    const expectedOutput = 'Simple Calculator (type \'exit\' to quit)\nEnter operations in format: number operator number\nExample: 5 + 3\n> Error: Please use format: number operator number\n> Calculator exited\n';
    const result = await runTest('Calculator', expectedOutput, t, { inputData });
    t.equal(result.output, expectedOutput, 'Calculator should handle invalid input');
    t.end();
});

test('Calculator.java - multiple operations', async (t) => {
    const inputData = '1 + 1\n10 * 10\n10 - 100\nexit';
    const expectedOutput = 'Simple Calculator (type \'exit\' to quit)\nEnter operations in format: number operator number\nExample: 5 + 3\n> Result: 2.0\n> Result: 100.0\n> Result: -90.0\n> Calculator exited\n';
    const result = await runTest('Calculator', expectedOutput, t, { inputData });
    t.equal(result.output, expectedOutput, 'Calculator should handle multiple operations');
    t.end();
});

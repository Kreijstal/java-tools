#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const DebugController = require('../src/debugController');

const STATE_FILE = path.join(__dirname, 'state.json');

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const classArg = args[1];

  if (command === 'start') {
    if (!classArg) {
      console.error('Error: Missing class name for "start" command.');
      console.log('Usage: node scripts/cli.js start <ClassName>');
      process.exit(1);
    }
    await startCommand(classArg);
  } else if (command === 'step') {
    await stepCommand();
  } else if (command === 'inspect') {
    await inspectCommand();
  } else {
    printUsage();
  }
}

function printUsage() {
  console.log(`
Usage: node scripts/cli.js <command> [options]

Commands:
  start <ClassName>   Initialize a debug session for a class.
                      e.g., node scripts/cli.js start Hello

  step                Execute the next instruction from the saved state.

  inspect             View the current JVM state (stack, locals, etc.).

  reset               Clear the saved state.
  `);
}

async function startCommand(className) {
  const controller = new DebugController();
  const classPath = path.join('sources', `${className}.class`);

  if (!fs.existsSync(classPath)) {
    console.error(`Error: Class file not found at '${classPath}'.`);
    console.log(`Please compile it first (e.g., javac sources/${className}.java)`);
    process.exit(1);
  }

  console.log(`🚀 Initializing debugger for ${className}`);
  await controller.start(classPath);
  saveState(controller);

  console.log('Debugger initialized. Ready to step.');
  const state = controller.getCurrentState();
  const sourceMapping = controller.getCurrentSourceMapping();
  console.log(
    `Initial state: PC: ${state.pc}, Line: ${sourceMapping.line || 'N/A'}, Instruction: ${sourceMapping.instruction || 'N/A'}`
  );
}

function saveState(controller) {
  const serializedState = controller.serialize();
  fs.writeFileSync(STATE_FILE, JSON.stringify(serializedState, null, 2));
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return null;
  }
  const stateJson = fs.readFileSync(STATE_FILE, 'utf-8');
  if (!stateJson || stateJson.trim() === '{}') {
    return null;
  }
  return JSON.parse(stateJson);
}

async function stepCommand() {
  const state = loadState();
  if (!state || !state.jvmState) {
    console.error('Error: No saved state found or state is invalid. Start a new run.');
    process.exit(1);
  }

  const controller = new DebugController();
  controller.deserialize(state);

  if (!controller.isPaused()) {
    console.log('✅ Execution has already completed.');
    // Clear the state file as it's for a completed run
    fs.writeFileSync(STATE_FILE, JSON.stringify({}, null, 2));
    return;
  }

  const currentState = controller.getCurrentState();
  const sourceMapping = controller.getCurrentSourceMapping();
  console.log(
    `Executing: PC: ${currentState.pc}, Line: ${sourceMapping.line || 'N/A'}, Instruction: ${sourceMapping.instruction || 'N/A'}`
  );

  const result = controller.stepInstruction();

  if (result.status === 'completed') {
    console.log('✅ Execution completed.');
    fs.writeFileSync(STATE_FILE, JSON.stringify({}, null, 2));
  } else {
    saveState(controller);
    const newState = controller.getCurrentState();
    console.log(`Stepped to PC: ${newState.pc}`);
  }
}

async function inspectCommand() {
  const state = loadState();
  if (!state || !state.jvmState) {
    console.error('Error: No saved state found. Start a new run.');
    process.exit(1);
  }

  const controller = new DebugController();
  controller.deserialize(state);

  if (!controller.isPaused()) {
    console.log('Execution has already completed. No state to inspect.');
    return;
  }

  const backtrace = controller.getBacktrace();
  const stack = controller.inspectStack();
  const locals = controller.inspectLocals();
  const currentState = controller.getCurrentState();
  const sourceMapping = controller.getCurrentSourceMapping();

  console.log('--- JVM State Inspection ---');

  console.log('\n[Current Position]');
  console.log(`  Class:    ${backtrace[0].className}`);
  console.log(`  Method:   ${backtrace[0].methodName}`);
  console.log(`  PC:       ${currentState.pc}`);
  console.log(`  Line:     ${sourceMapping.line || 'N/A'}`);
  console.log(`  Instr:    ${sourceMapping.instruction || 'N/A'}`);

  console.log('\n[Operand Stack]');
  if (stack.length > 0) {
    stack.forEach(item => {
      console.log(`  [${item.index}] ${item.description}`);
    });
  } else {
    console.log('  Stack is empty.');
  }

  console.log('\n[Local Variables]');
  if (locals.length > 0) {
    locals.forEach(local => {
      const valueDesc = controller.inspectLocalVariable(local.index)?.description || 'N/A';
      console.log(`  [${local.index}] ${local.name} (${local.type}): ${valueDesc}`);
    });
  } else {
    console.log('  No local variables.');
  }

  console.log('\n--------------------------');
}

if (require.main === module) {
  main().catch(error => {
    console.error('An error occurred:', error.message);
    process.exit(1);
  });
}

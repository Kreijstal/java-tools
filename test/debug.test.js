const test = require('tape');
const { JVM } = require('../src/jvm');
const DebugController = require('../src/debugController');

test('JVM Serialization', (t) => {
  const jvm = new JVM();
  
  // Load a simple class for testing
  const classData = jvm.loadClass('sources/VerySimple.class', { silent: true });
  t.ok(classData, 'Should load VerySimple.class');

  const mainMethod = jvm.findMainMethod(classData);
  t.ok(mainMethod, 'Should find main method');

  // Set up initial state
  jvm.enableDebugMode();
  jvm.addBreakpoint(0);
  jvm.addBreakpoint(5);
  
  const { Frame } = require('../src/jvm');
  const initialFrame = new Frame(mainMethod);
  jvm.callStack.push(initialFrame);

  // Serialize the state
  const serializedState = jvm.serialize();
  t.ok(serializedState, 'Should serialize JVM state');
  t.ok(serializedState.frames, 'Serialized state should have frames');
  t.ok(serializedState.classes, 'Serialized state should have classes');
  t.equal(serializedState.debugMode, true, 'Serialized state should preserve debug mode');
  t.equal(serializedState.breakpoints.length, 2, 'Serialized state should preserve breakpoints');

  // Create new JVM and deserialize
  const newJvm = new JVM();
  newJvm.deserialize(serializedState);
  
  t.equal(newJvm.debugMode, true, 'Deserialized JVM should have debug mode enabled');
  t.equal(newJvm.breakpoints.size, 2, 'Deserialized JVM should have breakpoints');
  t.equal(newJvm.callStack.size(), 1, 'Deserialized JVM should have call stack');
  
  const restoredFrame = newJvm.callStack.peek();
  t.equal(restoredFrame.method.name, 'main', 'Restored frame should be main method');
  t.equal(restoredFrame.pc, 0, 'Restored frame should have correct PC');

  t.end();
});

test('Debug Controller Basic Operations', (t) => {
  const controller = new DebugController();
  
  // Test initial state
  t.equal(controller.executionState, 'stopped', 'Initial state should be stopped');
  t.equal(controller.isPaused(), false, 'Should not be paused initially');
  t.equal(controller.isCompleted(), true, 'Should be completed initially');

  // Test loading a class
  try {
    const result = controller.start('sources/VerySimple.class');
    t.equal(result.status, 'started', 'Should start successfully');
    t.equal(controller.executionState, 'paused', 'Should be paused after start');
    t.equal(controller.isPaused(), true, 'Should report as paused');
  } catch (error) {
    t.fail(`Failed to start debugging: ${error.message}`);
  }

  // Test breakpoint operations
  const bpResult = controller.setBreakpoint(5);
  t.equal(bpResult.status, 'breakpoint_set', 'Should set breakpoint');
  t.equal(bpResult.pc, 5, 'Should set breakpoint at correct PC');

  const breakpoints = controller.getBreakpoints();
  t.ok(breakpoints.includes(5), 'Should include the set breakpoint');

  const removeBpResult = controller.removeBreakpoint(5);
  t.equal(removeBpResult.status, 'breakpoint_removed', 'Should remove breakpoint');

  const clearResult = controller.clearBreakpoints();
  t.equal(clearResult.status, 'breakpoints_cleared', 'Should clear breakpoints');

  t.end();
});

test('Debug Controller Serialization', (t) => {
  const controller = new DebugController();
  
  try {
    // Start debugging
    controller.start('sources/VerySimple.class');
    controller.setBreakpoint(3);
    controller.setBreakpoint(7);

    // Serialize state
    const serializedState = controller.serialize();
    t.ok(serializedState, 'Should serialize debug controller state');
    t.ok(serializedState.jvmState, 'Should include JVM state');
    t.equal(serializedState.executionState, 'paused', 'Should preserve execution state');

    // Create new debugger and restore state
    const newController = new DebugController();
    const restoreResult = newController.deserialize(serializedState);
    
    t.equal(restoreResult.status, 'restored', 'Should restore successfully');
    t.equal(newController.executionState, 'paused', 'Should restore execution state');
    
    const breakpoints = newController.getBreakpoints();
    t.equal(breakpoints.length, 2, 'Should restore breakpoints');
    t.ok(breakpoints.includes(3), 'Should restore breakpoint at 3');
    t.ok(breakpoints.includes(7), 'Should restore breakpoint at 7');

  } catch (error) {
    t.fail(`Debug controller serialization test failed: ${error.message}`);
  }

  t.end();
});

test('Debug Controller Step Operations', (t) => {
  const controller = new DebugController();
  
  try {
    // Start debugging
    controller.start('sources/VerySimple.class');
    
    // Test step into
    const stepResult = controller.stepInto();
    t.ok(stepResult, 'Step into should return result');
    t.ok(['paused', 'completed'].includes(stepResult.status), 'Step should result in pause or completion');

    // Get current state to verify it works
    const state = controller.getCurrentState();
    t.ok(state, 'Should get current state');
    t.ok(typeof state.pc === 'number' || state.pc === null, 'PC should be number or null');
    t.ok(Array.isArray(state.stack), 'Stack should be array');
    t.ok(Array.isArray(state.locals), 'Locals should be array');

  } catch (error) {
    t.fail(`Debug stepping test failed: ${error.message}`);
  }

  t.end();
});

test('Debug API Error Handling', (t) => {
  const controller = new DebugController();
  
  // Test operations on non-paused debugger
  try {
    controller.stepInto();
    t.fail('Should throw error when stepping on non-paused debugger');
  } catch (error) {
    t.ok(error.message.includes('execution is not paused'), 'Should throw appropriate error');
  }

  try {
    controller.continue();
    t.fail('Should throw error when continuing non-paused debugger');
  } catch (error) {
    t.ok(error.message.includes('execution is not paused'), 'Should throw appropriate error');
  }

  // Test loading invalid class
  try {
    controller.start('nonexistent.class');
    t.fail('Should throw error for nonexistent class');
  } catch (error) {
    t.ok(error.message.includes('Error loading class'), 'Should throw loading error');
  }

  t.end();
});
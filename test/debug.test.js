const test = require('tape');
const { JVM } = require('../src/jvm');
const DebugController = require('../src/debugController');

test('JVM Serialization', async (t) => {
  t.plan(2);

  const jvm = new JVM();
  
  // Serialize the state
  const serializedState = jvm.serialize();
  t.ok(serializedState, 'Should serialize JVM state');

  // Create new JVM and deserialize
  const newJvm = new JVM();
  newJvm.deserialize(serializedState);
  t.pass('Should deserialize without crashing');
});

test('Debug Controller Basic Operations', async (t) => {
  const controller = new DebugController({ classpath: 'sources' });
  
  // Test initial state
  t.equal(controller.executionState, 'stopped', 'Initial state should be stopped');
  t.equal(controller.isPaused(), false, 'Should not be paused initially');
  t.equal(controller.isCompleted(), true, 'Should be completed initially');

  // Test loading a class
  try {
    const result = await controller.start('VerySimple');
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

test('Debug Controller Serialization', async (t) => {
  const controller = new DebugController({ classpath: 'sources' });
  
  try {
    // Start debugging
    await controller.start('VerySimple');
    controller.setBreakpoint(3);
    controller.setBreakpoint(7);

    // Serialize state
    const serializedState = controller.serialize();
    t.ok(serializedState, 'Should serialize debug controller state');
    t.ok(serializedState.jvmState, 'Should include JVM state');
    t.equal(serializedState.executionState, 'paused', 'Should preserve execution state');

    // Create new debugger and restore state
    const newController = new DebugController({ classpath: 'sources' });
    const restoreResult = await newController.deserialize(serializedState);
    
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

test('Debug Controller Step Operations', async (t) => {
  const controller = new DebugController({ classpath: 'sources' });
  
  try {
    // Start debugging
    await controller.start('VerySimple');
    
    // Test step into
    const stepResult = await controller.stepInto();
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

test('Debug API Error Handling', async (t) => {
  const controller = new DebugController({ classpath: 'sources' });
  t.plan(3);
  
  // Test operations on non-paused debugger
  try {
    await controller.stepInto();
    t.fail('Should throw error when stepping on non-paused debugger');
  } catch (error) {
    t.ok(error.message.includes('execution is not paused'), 'Should throw appropriate error');
  }

  try {
    await controller.continue();
    t.fail('Should throw error when continuing non-paused debugger');
  } catch (error) {
    t.ok(error.message.includes('execution is not paused'), 'Should throw appropriate error');
  }

  // Test loading invalid class
  const originalConsoleError = console.error;
  console.error = () => {}; // Suppress expected error message
  try {
    await controller.start('nonexistent.class');
    t.fail('Should throw error for nonexistent class');
  } catch (error) {
    t.ok(error.message.includes('Error loading class'), 'Should throw loading error');
  } finally {
    console.error = originalConsoleError; // Restore console.error
  }
});
const test = require('tape');
const { JVM, Frame } = require('../src/jvm');
const DebugController = require('../src/debugController');

test('Enhanced Debug Features - Backtrace with method arguments', async (t) => {
  const controller = new DebugController();
  
  try {
    await controller.start('sources/VerySimple.class');
    controller.stepInto(); // Execute iconst_3
    controller.stepInto(); // Execute istore_1
    
    const backtrace = controller.getBacktrace();
    
    t.equal(backtrace.length, 1, 'Should have one frame in backtrace');
    t.equal(backtrace[0].className, 'VerySimple', 'Should have correct class name');
    t.equal(backtrace[0].methodName, 'main', 'Should have correct method name');
    t.equal(backtrace[0].methodDescriptor, '([Ljava/lang/String;)V', 'Should have correct method descriptor');
    t.equal(backtrace[0].isCurrentFrame, true, 'Should mark as current frame');
    
    // Check arguments (should only have arg0 for static method)
    t.equal(backtrace[0].arguments.length, 1, 'Should have one argument for static main method');
    t.equal(backtrace[0].arguments[0].name, 'arg0', 'Should have correct argument name');
    t.equal(backtrace[0].arguments[0].type, 'java.lang.String[]', 'Should have correct argument type');
    
    t.end();
  } catch (error) {
    t.fail(`Test failed with error: ${error.message}`);
    t.end();
  }
});

test('Enhanced Debug Features - Stack inspection', async (t) => {
  const controller = new DebugController();
  
  try {
    await controller.start('sources/VerySimple.class');
    controller.stepInto(); // Execute iconst_3 (pushes 3 to stack)
    
    const stackInspection = controller.inspectStack();
    
    t.equal(stackInspection.length, 1, 'Should have one item on stack');
    t.equal(stackInspection[0].value, 3, 'Should have correct stack value');
    t.equal(stackInspection[0].type, 'int', 'Should have correct stack type');
    t.equal(stackInspection[0].index, 0, 'Should have correct stack index');
    
    t.end();
  } catch (error) {
    t.fail(`Test failed with error: ${error.message}`);
    t.end();
  }
});

test('Enhanced Debug Features - Local variables inspection', async (t) => {
  const controller = new DebugController();
  
  try {
    await controller.start('sources/VerySimple.class');
    controller.stepInto(); // Execute iconst_3
    controller.stepInto(); // Execute istore_1 (stores 3 in local 1)
    
    const localsInspection = controller.inspectLocals();
    
    t.equal(localsInspection.length, 4, 'VerySimple should have 4 local slots');
    t.equal(localsInspection[1].value, 3, 'Local 1 should contain value 3');
    t.equal(localsInspection[1].type, 'int', 'Local 1 should be int type');
    t.equal(localsInspection[1].name, 'local_1', 'Local 1 should have correct name');
    
    t.end();
  } catch (error) {
    t.fail(`Test failed with error: ${error.message}`);
    t.end();
  }
});

test('Enhanced Debug Features - Specific local variable inspection', async (t) => {
  const controller = new DebugController();
  
  try {
    await controller.start('sources/VerySimple.class');
    controller.stepInto(); // Execute iconst_3
    controller.stepInto(); // Execute istore_1 (stores 3 in local 1)
    
    const localVar = controller.inspectLocalVariable(1);
    
    t.ok(localVar, 'Should return local variable info');
    t.equal(localVar.value, 3, 'Should have correct value');
    t.equal(localVar.type, 'int', 'Should have correct type');
    t.equal(localVar.index, 1, 'Should have correct index');
    t.equal(localVar.name, 'local_1', 'Should have correct name');
    
    t.end();
  } catch (error) {
    t.fail(`Test failed with error: ${error.message}`);
    t.end();
  }
});

test('Enhanced Debug Features - Specific stack value inspection', async (t) => {
  const controller = new DebugController();
  
  try {
    await controller.start('sources/VerySimple.class');
    controller.stepInto(); // Execute iconst_3 (pushes 3 to stack)
    
    const stackValue = controller.inspectStackValue(0);
    
    t.ok(stackValue, 'Should return stack value info');
    t.equal(stackValue.value, 3, 'Should have correct value');
    t.equal(stackValue.type, 'int', 'Should have correct type');
    t.equal(stackValue.index, 0, 'Should have correct index');
    
    t.end();
  } catch (error) {
    t.fail(`Test failed with error: ${error.message}`);
    t.end();
  }
});

test('Enhanced Debug Features - Negative stack indices', async (t) => {
  const controller = new DebugController();
  
  try {
    await controller.start('sources/VerySimple.class');
    controller.stepInto(); // Execute iconst_3 (pushes 3 to stack)
    
    const topStackValue = controller.inspectStackValue(-1);
    
    t.ok(topStackValue, 'Should return top stack value');
    t.equal(topStackValue.value, 3, 'Should have correct value');
    t.equal(topStackValue.type, 'int', 'Should have correct type');
    t.equal(topStackValue.index, 0, 'Should have correct index (only one item on stack)');
    
    t.end();
  } catch (error) {
    t.fail(`Test failed with error: ${error.message}`);
    t.end();
  }
});

test('Enhanced Debug Features - Invalid indices handling', async (t) => {
  const controller = new DebugController();
  
  try {
    await controller.start('sources/VerySimple.class');
    
    const invalidLocal = controller.inspectLocalVariable(99);
    const invalidStack = controller.inspectStackValue(99);
    
    t.equal(invalidLocal, null, 'Should return null for invalid local index');
    t.equal(invalidStack, null, 'Should return null for invalid stack index');
    
    t.end();
  } catch (error) {
    t.fail(`Test failed with error: ${error.message}`);
    t.end();
  }
});

test('Enhanced Debug Features - Available variable names', async (t) => {
  const controller = new DebugController();
  
  try {
    await controller.start('sources/VerySimple.class');
    
    const variableNames = controller.getAvailableVariableNames();
    
    t.equal(variableNames.length, 4, 'Should have 4 variable names');
    t.ok(variableNames.includes('local_0'), 'Should include local_0');
    t.ok(variableNames.includes('local_1'), 'Should include local_1');
    t.ok(variableNames.includes('local_2'), 'Should include local_2');
    t.ok(variableNames.includes('local_3'), 'Should include local_3');
    
    t.end();
  } catch (error) {
    t.fail(`Test failed with error: ${error.message}`);
    t.end();
  }
});

test('Enhanced Debug Features - Object inspection with null values', (t) => {
  const controller = new DebugController();
  
  const objectInspection = controller.inspectObject(null);
  t.equal(objectInspection, null, 'Should return null for null object');
  
  const primitiveInspection = controller.inspectObject(42);
  t.equal(primitiveInspection, null, 'Should return null for primitive value');
  
  t.end();
});

test('Enhanced Debug Features - Empty call stack handling', (t) => {
  const emptyController = new DebugController();
  
  const backtrace = emptyController.getBacktrace();
  const stackInspection = emptyController.inspectStack();
  const localsInspection = emptyController.inspectLocals();
  const variableNames = emptyController.getAvailableVariableNames();
  
  t.equal(backtrace.length, 0, 'Empty backtrace for empty call stack');
  t.equal(stackInspection.length, 0, 'Empty stack inspection for empty call stack');
  t.equal(localsInspection.length, 0, 'Empty locals inspection for empty call stack');
  t.equal(variableNames.length, 0, 'Empty variable names for empty call stack');
  
  t.end();
});
const test = require('tape');
const { JVM } = require('../src/jvm');
const invokeHandlers = require('../src/instructions/invoke');
const Frame = require('../src/frame');

test('Invoke instructions should validate method access flags', async function(t) {
  t.plan(4);

  const jvm = new JVM();
  
  // Load our test class
  const classData = await jvm.loadClassAsync('sources/StaticVsInstanceTest.class');
  jvm.classes['StaticVsInstanceTest'] = classData;
  
  // Create a mock thread and frame
  const thread = {
    callStack: {
      push: () => {},
      pop: () => {},
      peek: () => ({})
    }
  };
  
  // Create a frame with a mock stack
  const frame = {
    stack: [5, 3], // Mock arguments for (II)I methods
    pc: 0
  };
  
  try {
    // Test 1: invokestatic on a static method - should work
    const staticInstruction = {
      op: 'invokestatic',
      arg: ['Method', 'StaticVsInstanceTest', ['staticMethod', '(II)I']]
    };
    
    // Reset stack
    frame.stack = [5, 3];
    await invokeHandlers.invokestatic(frame, staticInstruction, jvm, thread);
    t.pass('invokestatic on static method should work');
  } catch (error) {
    t.fail('invokestatic on static method should not throw: ' + error.message);
  }
  
  try {
    // Test 2: invokestatic on instance method - should fail
    const instanceViaStaticInstruction = {
      op: 'invokestatic',
      arg: ['Method', 'StaticVsInstanceTest', ['instanceMethod', '(II)I']]
    };
    
    // Reset stack  
    frame.stack = [5, 3];
    await invokeHandlers.invokestatic(frame, instanceViaStaticInstruction, jvm, thread);
    t.fail('invokestatic on instance method should throw an error');
  } catch (error) {
    t.ok(error.message.includes('invokestatic called on non-static method'), 
         'invokestatic on instance method should throw IncompatibleClassChangeError');
  }
  
  try {
    // Test 3: invokevirtual on static method - should fail
    const staticViaVirtualInstruction = {
      op: 'invokevirtual', 
      arg: ['Method', 'StaticVsInstanceTest', ['staticMethod', '(II)I']]
    };
    
    // Stack setup: object at bottom, then arg1, arg2 on top
    frame.stack = [{ type: 'StaticVsInstanceTest' }, 5, 3];
    await invokeHandlers.invokevirtual(frame, staticViaVirtualInstruction, jvm, thread);
    t.fail('invokevirtual on static method should throw an error');
  } catch (error) {
    t.ok(error.message.includes('invokevirtual called on static method'), 
         'invokevirtual on static method should throw IncompatibleClassChangeError');
  }
  
  try {
    // Test 4: invokeinterface on static method - should fail
    const staticViaInterfaceInstruction = {
      op: 'invokeinterface', 
      arg: ['Method', 'StaticVsInstanceTest', ['staticMethod', '(II)I']]
    };
    
    // Stack setup: object at bottom, then arg1, arg2 on top
    frame.stack = [{ type: 'StaticVsInstanceTest' }, 5, 3];
    await invokeHandlers.invokeinterface(frame, staticViaInterfaceInstruction, jvm, thread);
    t.fail('invokeinterface on static method should throw an error');
  } catch (error) {
    t.ok(error.message.includes('invokeinterface called on static method'), 
         'invokeinterface on static method should throw IncompatibleClassChangeError');
  }
});
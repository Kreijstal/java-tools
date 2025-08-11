#!/usr/bin/env node

const DebugController = require('../src/debugController');

/**
 * Example usage of the JVM Debug API
 * This demonstrates pausing, resuming, stepping, and state serialization
 */

async function demonstrateDebugAPI() {
  console.log('🔍 JVM Debug API Demonstration\n');

  // Create a debug controller
  const controller = new DebugController();
  
  try {
    // 1. Start debugging a simple program
    console.log('1. Starting debug session with VerySimple.class...');
    const startResult = await controller.start('sources/VerySimple.class');
    console.log(`   Status: ${startResult.status}`);
    console.log(`   Initial PC: ${startResult.state.pc}`);
    console.log('');

    // 2. Set some breakpoints
    console.log('2. Setting breakpoints...');
    controller.setBreakpoint(5);
    controller.setBreakpoint(10);
    console.log(`   Breakpoints set at: ${controller.getBreakpoints().join(', ')}`);
    console.log('');

    // 3. Step through some instructions
    console.log('3. Stepping through execution...');
    
    let stepCount = 0;
    while (stepCount < 3 && controller.isPaused()) {
      const state = controller.getCurrentState();
      const sourceMapping = controller.getCurrentSourceMapping();
      console.log(`   Step ${stepCount + 1}: PC=${state.pc}, Stack=[${state.stack.join(', ')}]`);
      console.log(`      Source: line ${sourceMapping.line}, instruction: ${sourceMapping.instruction}`);
      
      const stepResult = controller.stepInto();
      stepCount++;
      
      if (stepResult.status === 'completed') {
        console.log('   Execution completed during stepping');
        break;
      }
    }
    console.log('');

    // 4. Demonstrate serialization
    console.log('4. Serializing JVM state...');
    const serializedState = controller.serialize();
    console.log(`   Serialized state size: ${JSON.stringify(serializedState).length} bytes`);
    console.log(`   Execution state: ${serializedState.executionState}`);
    console.log(`   Breakpoints: ${serializedState.jvmState.breakpoints.length}`);
    console.log('');

    // 5. Create new controller and restore state
    console.log('5. Creating new controller and restoring state...');
    const newController = new DebugController();
    const restoreResult = newController.deserialize(serializedState);
    console.log(`   Restore status: ${restoreResult.status}`);
    console.log(`   Restored breakpoints: ${newController.getBreakpoints().join(', ')}`);
    console.log(`   Execution state: ${newController.executionState}`);
    console.log('');

    // 6. Continue execution from restored state
    console.log('6. Continuing execution from restored state...');
    if (newController.isPaused()) {
      const continueResult = newController.continue();
      console.log(`   Continue result: ${continueResult.status}`);
      
      if (continueResult.status === 'paused') {
        console.log(`   Paused at PC: ${continueResult.pc}`);
      } else {
        console.log('   Execution completed');
      }
    } else {
      console.log('   Controller is not in paused state');
    }
    console.log('');

    // 7. Demonstrate different step modes
    console.log('7. Demonstrating step modes...');
    if (newController.isPaused()) {
      console.log('   Step Over:');
      const stepOverResult = newController.stepOver();
      console.log(`     Result: ${stepOverResult.status}`);
      
      if (newController.isPaused()) {
        console.log('   Step Out:');
        const stepOutResult = newController.stepOut();
        console.log(`     Result: ${stepOutResult.status}`);
      }
    }

    // 8. Show disassembly view
    console.log('\n');
    const disassembly = newController.getDisassemblyView();
    console.log(disassembly.formattedDisassembly);

    // 9. Show enhanced debugging features - backtrace and value inspection
    console.log('\n9. Enhanced Debugging Features');
    console.log('================================================================================');
    
    if (newController.isPaused()) {
      // Show backtrace
      console.log('\n--- Call Stack Backtrace ---');
      const backtrace = newController.getBacktrace();
      backtrace.forEach((frame, index) => {
        console.log(`Frame ${index}: ${frame.className}.${frame.methodName}${frame.methodDescriptor}`);
        console.log(`  PC: ${frame.pc}, Source Line: ${frame.sourceLine || 'unknown'}`);
        console.log(`  Arguments:`);
        frame.arguments.forEach(arg => {
          console.log(`    ${arg.name} (${arg.type}): ${arg.value !== undefined ? arg.value : 'undefined'}`);
        });
        if (frame.stack.length > 0) {
          console.log(`  Stack: [${frame.stack.join(', ')}]`);
        }
        console.log('');
      });

      // Show stack inspection
      console.log('--- Stack Inspection ---');
      const stackInspection = newController.inspectStack();
      if (stackInspection.length > 0) {
        stackInspection.forEach(item => {
          console.log(`  [${item.index}] ${item.description}`);
        });
      } else {
        console.log('  Stack is empty');
      }
      console.log('');

      // Show local variables inspection
      console.log('--- Local Variables Inspection ---');
      const localsInspection = newController.inspectLocals();
      localsInspection.forEach(local => {
        console.log(`  ${local.name} (index ${local.index}, ${local.type}): ${local.value !== undefined ? local.value : 'undefined'}`);
      });
      console.log('');

      // Show available variable names
      console.log('--- Available Variable Names ---');
      const variableNames = newController.getAvailableVariableNames();
      console.log(`  Variables: ${variableNames.join(', ')}`);
      console.log('');

      // Test specific variable inspection
      console.log('--- Specific Variable Inspection ---');
      const localVar1 = newController.inspectLocalVariable(1);
      if (localVar1) {
        console.log(`  Local variable 1: ${localVar1.description}`);
      }
      
      // Test stack value inspection
      const topStackValue = newController.inspectStackValue(-1);
      if (topStackValue) {
        console.log(`  Top stack value: ${topStackValue.description}`);
      } else {
        console.log('  No values on stack');
      }
    } else {
      console.log('Cannot inspect values - execution is not paused');
    }

  } catch (error) {
    console.error(`❌ Error during demonstration: ${error.message}`);
    console.error(error.stack);
  }

  console.log('\n✅ Debug API demonstration completed!');
}

function printUsage() {
  console.log('Usage: node scripts/debugDemo.js [class-file]');
  console.log('');
  console.log('Examples:');
  console.log('  node scripts/debugDemo.js                  # Use default VerySimple.class');
  console.log('  node scripts/debugDemo.js Hello.class      # Debug Hello.class');
  console.log('');
  console.log('Available debug commands in the API:');
  console.log('  controller.start(classFile)               # Start debugging');
  console.log('  controller.stepInto()                     # Step into method calls');
  console.log('  controller.stepOver()                     # Step over method calls');
  console.log('  controller.stepOut()                      # Step out of current method');
  console.log('  controller.stepInstruction()              # Execute single instruction');
  console.log('  controller.finish()                       # Run until method returns');
  console.log('  controller.continue()                     # Continue execution');
  console.log('  controller.setBreakpoint(pc)              # Set breakpoint');
  console.log('  controller.removeBreakpoint(pc)           # Remove breakpoint');
  console.log('  controller.serialize()                    # Serialize state');
  console.log('  controller.deserialize(state)             # Restore state');
  console.log('  controller.getCurrentState()              # Get execution state');
  console.log('');
  console.log('Enhanced debugging features:');
  console.log('  controller.getBacktrace()                 # Get call stack with arguments');
  console.log('  controller.inspectStack()                 # Inspect execution stack');
  console.log('  controller.inspectLocals()                # Inspect local variables');
  console.log('  controller.inspectLocalVariable(index)    # Inspect specific local variable');
  console.log('  controller.inspectStackValue(index)       # Inspect specific stack value');
  console.log('  controller.inspectObject(objRef)          # Inspect object fields');
  console.log('  controller.findVariableByName(name)       # Find variable by name');
  console.log('  controller.getAvailableVariableNames()    # Get all variable names');
}

// Main execution
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  demonstrateDebugAPI().catch(error => {
    console.error('Failed to run demonstration:', error.message);
    process.exit(1);
  });
}

module.exports = { demonstrateDebugAPI };
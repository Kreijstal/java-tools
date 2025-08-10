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
    const startResult = controller.start('sources/VerySimple.class');
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
    console.log('\n8. Disassembly view with current execution position:');
    const disassembly = newController.getDisassemblyView();
    console.log(`   Method: ${disassembly.method.name}${disassembly.method.descriptor}`);
    console.log(`   Current PC: ${disassembly.currentPc}`);
    console.log(`   Source mapping: line ${disassembly.sourceMapping.line} in ${disassembly.sourceMapping.sourceFile}`);
    console.log('   Instructions:');
    disassembly.instructions.forEach(instr => {
      const marker = instr.isCurrent ? ' >' : '  ';
      const lineInfo = instr.sourceMapping.line ? ` (line ${instr.sourceMapping.line})` : '';
      console.log(`${marker} PC=${instr.pc}: ${instr.instruction}${lineInfo}`);
    });

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
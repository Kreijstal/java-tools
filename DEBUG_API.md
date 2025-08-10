# JVM Debug API and Serialization

This document describes the comprehensive JVM debugging and state serialization features added to the java-tools project.

## Overview

The enhanced JVM implementation now supports:

1. **Complete JVM state serialization/deserialization** - pause and resume execution across different Node.js runtime instances
2. **Comprehensive debug API** - step-by-step execution control with breakpoints
3. **Backtrace and call stack inspection** - detailed view of method calls with arguments
4. **Value inspection** - examine stack values, local variables, and object fields
5. **JavaScript debug interface** - high-level API for debug operations

## Features

### JVM State Serialization

The JVM can now serialize its complete execution state, including:
- Call stack with all frames
- Operand stacks and local variables
- Program counters and method information
- Loaded classes and debug state
- Breakpoints and stepping configuration

```javascript
const jvm = new JVM();
// ... load class and set up execution

// Serialize complete state
const state = jvm.serialize();

// Create new JVM instance and restore state
const newJvm = new JVM();
newJvm.deserialize(state);
// Execution continues from exact same point
```

### Debug API

The debug API provides fine-grained control over JVM execution:

#### Step Commands
- **Step Into** - Execute next instruction, entering method calls
- **Step Over** - Execute next instruction, but skip over method calls  
- **Step Out** - Continue until current method returns
- **Step Instruction** - Execute exactly one bytecode instruction
- **Finish** - Run until current method completes

#### Breakpoint Management
- Set breakpoints at specific program counter locations
- Remove individual breakpoints or clear all

#### Backtrace and Call Stack Inspection

The debugger now provides detailed call stack information with method arguments:

```javascript
const controller = new DebugController();
controller.start('MyClass.class');

// Get detailed backtrace with arguments and local variables
const backtrace = controller.getBacktrace();
backtrace.forEach(frame => {
  console.log(`${frame.className}.${frame.methodName}`);
  console.log(`  PC: ${frame.pc}, Line: ${frame.sourceLine}`);
  
  frame.arguments.forEach(arg => {
    console.log(`  Arg ${arg.name} (${arg.type}): ${arg.value}`);
  });
});
```

#### Value Inspection

Comprehensive value inspection capabilities for debugging:

```javascript
// Inspect execution stack
const stackValues = controller.inspectStack();
stackValues.forEach(item => {
  console.log(`Stack[${item.index}]: ${item.description}`);
});

// Inspect local variables
const locals = controller.inspectLocals();
locals.forEach(local => {
  console.log(`${local.name}: ${local.value} (${local.type})`);
});

// Inspect specific values
const localVar = controller.inspectLocalVariable(1);
const stackTop = controller.inspectStackValue(-1);

// Get available variable names
const variableNames = controller.getAvailableVariableNames();

// Find variable by name (if debug info available)
const variable = controller.findVariableByName('myVar');

// Inspect object fields
const objectInfo = controller.inspectObject(objReference);
```
- Automatic pause when breakpoints are hit

#### State Inspection
- View current program counter, stack, and local variables
- Examine call stack depth and current method
- Access complete execution state at any time

## Usage Examples

### Basic Debug Controller

```javascript
const DebugController = require('./src/debugController');

const controller = new DebugController();

// Start debugging a program
const result = controller.start('sources/Hello.class');
console.log(`Status: ${result.status}`); // "started"

// Set breakpoints
controller.setBreakpoint(5);
controller.setBreakpoint(10);

// Step through execution
const stepResult = controller.stepInto();
console.log(`Current PC: ${stepResult.pc}`);

// Continue until breakpoint or completion
const continueResult = controller.continue();
console.log(`Status: ${continueResult.status}`); // "paused" or "completed"

// Inspect current state
const state = controller.getCurrentState();
console.log(`Stack: [${state.stack.join(', ')}]`);
console.log(`Locals: [${state.locals.join(', ')}]`);

// Enhanced debugging features
const backtrace = controller.getBacktrace();
console.log('Call Stack:');
backtrace.forEach((frame, index) => {
  console.log(`  Frame ${index}: ${frame.className}.${frame.methodName}`);
  console.log(`    PC: ${frame.pc}, Line: ${frame.sourceLine}`);
  frame.arguments.forEach(arg => {
    console.log(`    ${arg.name}: ${arg.value} (${arg.type})`);
  });
});

// Inspect stack and local variables
const stackInspection = controller.inspectStack();
const localsInspection = controller.inspectLocals();

console.log('Stack Values:', stackInspection.map(s => s.description));
console.log('Local Variables:', localsInspection.map(l => `${l.name}: ${l.value}`));
```

### State Serialization

```javascript
// Start debugging and make some progress
controller.start('sources/Calculator.class');
controller.stepInto();
controller.stepInto();
controller.setBreakpoint(15);

// Serialize the state
const serializedState = controller.serialize();

// Save to file or database
require('fs').writeFileSync('debug-state.json', JSON.stringify(serializedState));

// Later, in different process/runtime:
const savedState = JSON.parse(require('fs').readFileSync('debug-state.json'));

const newController = new DebugController();
newController.deserialize(savedState);

// Continue from exact same execution point
const continueResult = newController.continue();
```

### Web Application Integration

```javascript
// Express.js route example
app.post('/debug/start', (req, res) => {
    const controller = new DebugController();
    const result = controller.start(req.body.classFile);
    
    res.json({
        status: result.status,
        state: controller.getCurrentState()
    });
});

app.post('/debug/step/:type', (req, res) => {
    const { type } = req.params;
    let result;
    
    switch (type) {
        case 'into': result = controller.stepInto(); break;
        case 'over': result = controller.stepOver(); break;
        case 'out': result = controller.stepOut(); break;
        case 'instruction': result = controller.stepInstruction(); break;
    }
    
    res.json(result);
});

app.post('/debug/serialize', (req, res) => {
    const state = controller.serialize();
    // Store in session or database
    req.session.debugState = state;
    res.json({ status: 'serialized', size: JSON.stringify(state).length });
});
```

### Enhanced Value Inspection

```javascript
// Detailed variable inspection example
const controller = new DebugController();
controller.start('sources/Calculator.class');

// Execute a few steps to have data on stack and in locals
controller.stepInto();
controller.stepInto();

// Get complete backtrace with method arguments
const backtrace = controller.getBacktrace();
console.log('=== CALL STACK BACKTRACE ===');
backtrace.forEach((frame, index) => {
  console.log(`Frame ${index}: ${frame.className}.${frame.methodName}${frame.methodDescriptor}`);
  console.log(`  PC: ${frame.pc}, Source Line: ${frame.sourceLine || 'unknown'}`);
  console.log(`  Return Type: ${frame.returnType}`);
  
  console.log('  Arguments:');
  frame.arguments.forEach(arg => {
    console.log(`    ${arg.name} (${arg.type}): ${arg.value !== undefined ? arg.value : 'undefined'}`);
  });
  
  console.log('  Local Variables:');
  frame.localVariables.forEach(local => {
    console.log(`    [${local.index}] ${local.name} (${local.type}): ${local.value !== undefined ? local.value : 'undefined'}`);
  });
  
  if (frame.stack.length > 0) {
    console.log(`  Stack: [${frame.stack.join(', ')}]`);
  }
  console.log('');
});

// Inspect specific values
console.log('=== VALUE INSPECTION ===');

// Stack inspection
const stackValues = controller.inspectStack();
console.log('Stack Values:');
stackValues.forEach(item => {
  console.log(`  [${item.index}] ${item.description}`);
});

// Local variable inspection
const locals = controller.inspectLocals();
console.log('Local Variables:');
locals.forEach(local => {
  console.log(`  ${local.name} [${local.index}]: ${local.value !== undefined ? local.value : 'undefined'} (${local.type})`);
});

// Specific variable inspection
const localVar1 = controller.inspectLocalVariable(1);
if (localVar1) {
  console.log(`Local variable 1: ${localVar1.description}`);
}

// Stack value inspection (negative index for top of stack)
const topStackValue = controller.inspectStackValue(-1);
if (topStackValue) {
  console.log(`Top stack value: ${topStackValue.description}`);
}

// Available variable names
const variableNames = controller.getAvailableVariableNames();
console.log(`Available variables: ${variableNames.join(', ')}`);

// Find variable by name (if debug info is available)
const variable = controller.findVariableByName('myVar');
if (variable) {
  console.log(`Found variable 'myVar': ${variable.description}`);
}
```

## API Reference

### JVM Class Methods

#### Serialization
- `serialize()` → `Object` - Returns complete JVM state
- `deserialize(state)` - Restores JVM from serialized state

#### Debug Control  
- `enableDebugMode()` - Enable debug stepping and breakpoints
- `disableDebugMode()` - Disable debug features
- `execute()` → `{paused: boolean, pc?: number, completed?: boolean}` - Execute with debug support

#### Breakpoints
- `addBreakpoint(pc)` - Add breakpoint at program counter
- `removeBreakpoint(pc)` - Remove specific breakpoint  
- `clearBreakpoints()` - Remove all breakpoints

#### Stepping
- `stepInto()` - Prepare to step into next instruction
- `stepOver()` - Prepare to step over method calls
- `stepOut()` - Prepare to step out of current method
- `stepInstruction()` - Prepare to step single instruction
- `finish()` - Prepare to run until method return
- `continue()` - Clear step mode and continue execution

#### State Inspection
- `getCurrentState()` → `Object` - Get current execution state
- `getBacktrace()` → `Array` - Get detailed call stack with arguments
- `inspectStack()` → `Array` - Inspect execution stack values
- `inspectLocals()` → `Array` - Inspect local variables with type info
- `inspectLocalVariable(index)` → `Object|null` - Inspect specific local variable
- `inspectStackValue(index)` → `Object|null` - Inspect specific stack value
- `inspectObject(objRef)` → `Object|null` - Inspect object fields
- `findVariableByName(name)` → `Object|null` - Find variable by name
- `getAvailableVariableNames()` → `Array` - Get all variable names
- `getSourceLineMapping(pc, method)` → `Object` - Get source line for PC

### DebugController Class Methods

#### Session Management
- `start(classFilePath, options?)` → `{status, state}` - Start debug session
- `reset()` → `{status}` - Reset to initial state

#### Execution Control
- `continue()` → `{status, pc?, state}` - Continue execution
- `stepInto()` → `{status, pc?, state}` - Step into next instruction
- `stepOver()` → `{status, pc?, state}` - Step over method calls
- `stepOut()` → `{status, pc?, state}` - Step out of current method
- `stepInstruction()` → `{status, pc?, state}` - Execute single instruction
- `finish()` → `{status, pc?, state}` - Run until method returns

#### Breakpoint Management
- `setBreakpoint(pc)` → `{status, pc}` - Set breakpoint
- `removeBreakpoint(pc)` → `{status, pc}` - Remove breakpoint
- `clearBreakpoints()` → `{status}` - Clear all breakpoints
- `getBreakpoints()` → `number[]` - Get all breakpoint locations

#### State Management
- `serialize()` → `Object` - Serialize complete state
- `deserialize(state)` → `{status, state}` - Restore from serialized state
- `getCurrentState()` → `Object` - Get current execution state
- `getDisassemblyView()` → `Object` - Get formatted disassembly with current position
- `getCurrentSourceMapping()` → `Object` - Get source line mapping for current PC

#### Enhanced Debugging
- `getBacktrace()` → `Array` - Get detailed call stack with arguments and locals
- `inspectStack()` → `Array` - Inspect execution stack values with type information
- `inspectLocals()` → `Array` - Inspect local variables with names and types
- `inspectLocalVariable(index)` → `Object|null` - Inspect specific local variable by index
- `inspectStackValue(index)` → `Object|null` - Inspect specific stack value by index (supports negative indices)
- `inspectObject(objRef)` → `Object|null` - Inspect object fields and properties
- `findVariableByName(name)` → `Object|null` - Find variable by name (requires debug info)
- `getAvailableVariableNames()` → `Array` - Get list of all available variable names

#### Status Queries
- `isPaused()` → `boolean` - Check if execution is paused
- `isCompleted()` → `boolean` - Check if execution completed

## Examples and Demos

### Command Line Demo
```bash
node scripts/debugDemo.js
```
Demonstrates all debug features with VerySimple.class

### Web Interface Demo
Open `examples/debug-web-interface.html` in a browser to see a visual debug interface demonstration.

## Testing

The debug functionality is thoroughly tested:

```bash
npm test
```

Tests include:
- JVM state serialization and deserialization
- Debug controller operations
- Step execution modes
- Breakpoint management
- Error handling
- State persistence across runtime instances

## Integration Notes

### Node.js Backend Integration
The debug controller is designed to run in Node.js backend services. For web applications:

1. Create debug sessions on the backend
2. Expose debug controls via REST API or WebSocket
3. Store serialized state in databases or session storage
4. Allow multiple clients to debug the same session

### Multi-Runtime Support
State serialization enables:
- Pausing execution in one Node.js process
- Transferring state to another process/server
- Resuming execution with full fidelity
- Load balancing debug sessions across servers

### Performance Considerations
- Debug mode adds minimal overhead when not stepping
- Serialization creates deep copies of all state
- Large call stacks will increase serialization time
- Consider compression for stored debug states

## Limitations

- Only supports bytecode instructions currently implemented in the JVM
- Exception handling during debug mode needs more testing
- Native method calls are not debuggable
- Multi-threading not yet supported

## Future Enhancements

- Watch expressions and variable modification
- Conditional breakpoints
- Call stack navigation
- Memory and performance profiling
- Integration with standard debug protocols (DAP)
- Hot code reloading during debug sessions
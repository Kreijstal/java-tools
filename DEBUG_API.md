# JVM Debug API and Serialization

This document describes the new JVM debugging and state serialization features added to the java-tools project.

## Overview

The enhanced JVM implementation now supports:

1. **Complete JVM state serialization/deserialization** - pause and resume execution across different Node.js runtime instances
2. **Comprehensive debug API** - step-by-step execution control with breakpoints
3. **JavaScript debug interface** - high-level API for debug operations

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
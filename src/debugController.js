const { JVM, Frame } = require('./jvm');

class DebugController {
  constructor() {
    this.jvm = new JVM();
    this.executionState = 'stopped'; // stopped, running, paused
    this.lastExecutionResult = null;
  }

  /**
   * Load and prepare a class for debugging
   * @param {string} classFilePath - Path to the .class file
   * @param {object} options - Loading options
   */
  async loadClass(classFilePath, options = {}) {
    try {
      const classData = await this.jvm.loadClassAsync(classFilePath, options);
      if (!classData) {
        throw new Error(`Failed to load class from ${classFilePath}`);
      }
      return classData;
    } catch (error) {
      throw new Error(`Error loading class: ${error.message}`);
    }
  }

  /**
   * Start debugging a program from the main method
   * @param {string} classFilePath - Path to the .class file
   * @param {object} options - Execution options
   */
  async start(classFilePath, options = {}) {
    const classData = await this.loadClass(classFilePath, options);
    
    const mainMethod = this.jvm.findMainMethod(classData);
    if (!mainMethod) {
      throw new Error('main method not found');
    }

    // Enable debug mode and set up initial frame
    this.jvm.enableDebugMode();
    const initialFrame = new Frame(mainMethod);
    
    this.jvm.callStack.push(initialFrame);
    this.executionState = 'paused';
    
    return {
      status: 'started',
      state: this.getCurrentState()
    };
  }

  /**
   * Continue execution until next breakpoint or completion
   */
  continue() {
    if (this.executionState !== 'paused') {
      throw new Error('Cannot continue: execution is not paused');
    }

    this.jvm.continue();
    this.executionState = 'running';
    
    const result = this.jvm.execute();
    this.lastExecutionResult = result;
    
    if (result.paused) {
      this.executionState = 'paused';
      return {
        status: 'paused',
        pc: result.pc,
        state: this.getCurrentState()
      };
    } else {
      this.executionState = 'stopped';
      return {
        status: 'completed',
        state: this.getCurrentState()
      };
    }
  }

  /**
   * Step into the next instruction (will enter method calls)
   */
  stepInto() {
    if (this.executionState !== 'paused') {
      throw new Error('Cannot step: execution is not paused');
    }

    this.jvm.stepInto();
    return this._executeStep();
  }

  /**
   * Step over the next instruction (will not enter method calls)
   */
  stepOver() {
    if (this.executionState !== 'paused') {
      throw new Error('Cannot step: execution is not paused');
    }

    this.jvm.stepOver();
    return this._executeStep();
  }

  /**
   * Step out of the current method
   */
  stepOut() {
    if (this.executionState !== 'paused') {
      throw new Error('Cannot step: execution is not paused');
    }

    this.jvm.stepOut();
    return this._executeStep();
  }

  /**
   * Execute a single instruction
   */
  stepInstruction() {
    if (this.executionState !== 'paused') {
      throw new Error('Cannot step: execution is not paused');
    }

    this.jvm.stepInstruction();
    return this._executeStep();
  }

  /**
   * Continue until the current method finishes
   */
  finish() {
    if (this.executionState !== 'paused') {
      throw new Error('Cannot step: execution is not paused');
    }

    this.jvm.finish();
    return this._executeStep();
  }

  _executeStep() {
    this.executionState = 'running';
    const result = this.jvm.execute();
    this.lastExecutionResult = result;
    
    if (result.paused) {
      this.executionState = 'paused';
      return {
        status: 'paused',
        pc: result.pc,
        state: this.getCurrentState()
      };
    } else {
      this.executionState = 'stopped';
      return {
        status: 'completed',
        state: this.getCurrentState()
      };
    }
  }

  /**
   * Set a breakpoint at the specified program counter
   * @param {number} pc - Program counter location
   */
  setBreakpoint(pc) {
    this.jvm.addBreakpoint(pc);
    return { status: 'breakpoint_set', pc: pc };
  }

  /**
   * Remove a breakpoint at the specified program counter
   * @param {number} pc - Program counter location
   */
  removeBreakpoint(pc) {
    this.jvm.removeBreakpoint(pc);
    return { status: 'breakpoint_removed', pc: pc };
  }

  /**
   * Clear all breakpoints
   */
  clearBreakpoints() {
    this.jvm.clearBreakpoints();
    return { status: 'breakpoints_cleared' };
  }

  /**
   * Get the current execution state
   */
  getCurrentState() {
    const jvmState = this.jvm.getCurrentState();
    return {
      executionState: this.executionState,
      pc: jvmState.pc,
      stack: jvmState.stack,
      locals: jvmState.locals,
      callStackDepth: jvmState.callStackDepth,
      method: jvmState.method,
      breakpoints: Array.from(this.jvm.breakpoints)
    };
  }

  /**
   * Serialize the complete JVM state for persistence
   */
  serialize() {
    return {
      jvmState: this.jvm.serialize(),
      executionState: this.executionState,
      lastExecutionResult: this.lastExecutionResult
    };
  }

  /**
   * Deserialize and restore JVM state
   * @param {object} state - Serialized state
   */
  deserialize(state) {
    this.jvm.deserialize(state.jvmState);
    this.executionState = state.executionState || 'stopped';
    this.lastExecutionResult = state.lastExecutionResult || null;
    
    return {
      status: 'restored',
      state: this.getCurrentState()
    };
  }

  /**
   * Reset the debugger to initial state
   */
  reset() {
    this.jvm = new JVM();
    this.executionState = 'stopped';
    this.lastExecutionResult = null;
    
    return { status: 'reset' };
  }

  /**
   * Get the list of all breakpoints
   */
  getBreakpoints() {
    return Array.from(this.jvm.breakpoints);
  }

  /**
   * Check if the debugger is currently paused
   */
  isPaused() {
    return this.executionState === 'paused';
  }

  /**
   * Check if execution is completed
   */
  isCompleted() {
    return this.executionState === 'stopped';
  }

  /**
   * Get disassembly view with current execution position
   * @returns {object} Disassembly view showing instructions and current position
   */
  getDisassemblyView() {
    return this.jvm.getDisassemblyView();
  }

  /**
   * Get source line mapping for current PC
   * @returns {object} Source line information for current execution position
   */
  getCurrentSourceMapping() {
    const state = this.getCurrentState();
    if (state.pc !== null && this.jvm.callStack && !this.jvm.callStack.isEmpty()) {
      const frame = this.jvm.callStack.peek();
      return this.jvm.getSourceLineMapping(state.pc, frame.method);
    }
    return { line: null, sourceFile: null, instruction: null, pc: null };
  }

  /**
   * Get detailed backtrace showing all call stack frames with arguments
   * @returns {Array} Array of frame information with method details and variables
   */
  getBacktrace() {
    return this.jvm.getBacktrace();
  }

  /**
   * Inspect the current execution stack
   * @returns {Array} Stack values with type and index information
   */
  inspectStack() {
    return this.jvm.inspectStack();
  }

  /**
   * Inspect local variables in the current frame
   * @returns {Array} Local variables with names, types, and values
   */
  inspectLocals() {
    return this.jvm.inspectLocals();
  }

  /**
   * Inspect a specific local variable by index
   * @param {number} index - Local variable index
   * @returns {object|null} Variable information or null if not found
   */
  inspectLocalVariable(index) {
    return this.jvm.inspectLocalVariable(index);
  }

  /**
   * Inspect a specific stack value by index
   * @param {number} index - Stack index (0 = bottom, -1 = top)
   * @returns {object|null} Stack value information or null if not found
   */
  inspectStackValue(index) {
    return this.jvm.inspectStackValue(index);
  }

  /**
   * Inspect an object's fields
   * @param {*} objRef - Object reference to inspect
   * @returns {object|null} Object field information or null if not an object
   */
  inspectObject(objRef) {
    return this.jvm.inspectObject(objRef);
  }

  /**
   * Find a variable by name in the current frame
   * @param {string} name - Variable name to search for
   * @returns {object|null} Variable information or null if not found
   */
  findVariableByName(name) {
    return this.jvm.findVariableByName(name);
  }

  /**
   * Get all available variable names in the current frame
   * @returns {Array} List of variable names
   */
  getAvailableVariableNames() {
    return this.jvm.getAvailableVariableNames();
  }
}

module.exports = DebugController;
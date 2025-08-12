const Stack = require('./stack');
const { loadClassByPath, loadClassByPathSync } = require('./classLoader');
const { parseDescriptor } = require('./typeParser');
const { formatInstruction, unparseDataStructures } = require('./convert_tree');
const jreMethods = require('./jre');
const dispatch = require('./instructions');
const Frame = require('./frame');

class JVM {
  constructor() {
    this.callStack = new Stack();
    this.classes = {};
    // Output callback for capturing println output in browser UI
    this.outputCallback = null;
    this.jre = {
      'java/lang/System': {
        'out': {
          'java/io/PrintStream': {
            'println': (str) => {
              console.log(str);
              // Also send to web UI if callback is set
              if (this.outputCallback) {
                this.outputCallback(str);
              }
            }
          }
        },
        'in': {
          'java/io/InputStream': {
            input: 'foo\nbar\nbaz\n',
            offset: 0,
            read: function() {
              if (this.offset < this.input.length) {
                return this.input.charCodeAt(this.offset++);
              }
              return -1;
            }
          }
        }
      }
    };
    // Debug state
    this.debugMode = false;
    this.breakpoints = new Set();
    this.stepMode = null; // null, 'into', 'over', 'out', 'instruction', 'finish'
    this.stepTargetDepth = null;
    this.stepTargetFrame = null;

    this._jreMethods = {
      'java/lang/String.concat': (obj, args) => obj + args[0],
      'java/lang/String.toUpperCase': (obj, args) => obj.toUpperCase(),
      'java/lang/String.toLowerCase': (obj, args) => obj.toLowerCase(),
      'java/lang/String.length': (obj, args) => obj.length,
      ...jreMethods
    };
  }

  internString(str) {
    return str;
  }

  /**
   * Set a callback function to capture println output for web UI
   * @param {function} callback - Function to call with println output
   */
  setOutputCallback(callback) {
    this.outputCallback = callback;
  }

  run(classFilePath, options = {}) {
    const classData = this.loadClassSync(classFilePath, options);
    if (!classData) {
      return;
    }

    const mainMethod = this.findMainMethod(classData);
    if (!mainMethod) {
      console.error('main method not found');
      return;
    }

    const initialFrame = new Frame(mainMethod);
    this.callStack.push(initialFrame);
    this.execute();
  }

  execute() {
    while (!this.callStack.isEmpty()) {
      const frame = this.callStack.peek();
      if (frame.pc >= frame.instructions.length) {
        this.callStack.pop();
        continue;
      }

      const instructionItem = frame.instructions[frame.pc];
      const instruction = instructionItem.instruction;
      const label = instructionItem.labelDef;
      // The pc is the bytecode offset, which we get from the label `L<pc>:`
      const currentPc = label ? parseInt(label.substring(1, label.length - 1)) : -1;

      // For stepping modes, execute one instruction first, then check if we should pause
      const shouldExecuteFirst = this.debugMode && this.stepMode && 
        (this.stepMode === 'into' || this.stepMode === 'instruction');

      // Check debug conditions before executing instruction (except for step modes that need to execute first)
      if (this.debugMode && !shouldExecuteFirst && this.shouldPause(currentPc, frame)) {
        // Pause execution - return control to caller
        return { paused: true, pc: currentPc, frame: frame };
      }

      frame.pc++;

      try {
        if (instruction) {
          this.executeInstruction(instruction, frame);
        }
      } catch (e) {
        this.handleException(e, currentPc);
      }

      // After executing instruction, check if we should pause for step modes
      if (this.debugMode && shouldExecuteFirst && this.shouldPauseAfterStep(currentPc, frame)) {
        // After stepping, the stack might be empty if the program finished.
        if (this.callStack.isEmpty()) {
            return { paused: false, completed: true };
        }

        // Get the new current PC after execution
        const nextFrame = this.callStack.peek();
        if (nextFrame && nextFrame.pc < nextFrame.instructions.length) {
          const nextInstructionItem = nextFrame.instructions[nextFrame.pc];
          const nextLabel = nextInstructionItem.labelDef;
          const nextPc = nextLabel ? parseInt(nextLabel.substring(1, nextLabel.length - 1)) : -1;
          return { paused: true, pc: nextPc, frame: nextFrame };
        } else {
          // If we're at the end of the method, just return the current state
          return { paused: true, pc: currentPc, frame: frame };
        }
      }
    }
    
    // Execution completed
    return { paused: false, completed: true };
  }

  shouldPause(currentPc, frame) {
    // Check breakpoints
    if (this.breakpoints.has(currentPc)) {
      this.stepMode = null; // Clear step mode when hitting breakpoint
      return true;
    }

    // Check step conditions (except for 'into' and 'instruction' which are handled after execution)
    if (this.stepMode && this.stepMode !== 'into' && this.stepMode !== 'instruction') {
      const currentDepth = this.callStack.size();
      
      switch (this.stepMode) {
        case 'over':
          // Pause when we're back at the same depth or shallower
          if (currentDepth <= this.stepTargetDepth) {
            this.stepMode = null;
            return true;
          }
          break;
          
        case 'out':
          // Pause when we've returned from current method
          if (currentDepth < this.stepTargetDepth) {
            this.stepMode = null;
            return true;
          }
          break;
          
        case 'finish':
          // Pause when the target frame finishes
          if (this.stepTargetFrame && !this.callStack.items.includes(this.stepTargetFrame)) {
            this.stepMode = null;
            return true;
          }
          break;
      }
    }

    return false;
  }

  shouldPauseAfterStep(currentPc, frame) {
    // This method handles step modes that need to execute first then pause
    if (this.stepMode) {
      switch (this.stepMode) {
        case 'instruction':
          // Pause after executing one instruction
          this.stepMode = null;
          return true;
          
        case 'into':
          // Pause after executing one instruction (step into calls)
          this.stepMode = null;
          return true;
      }
    }

    return false;
  }

  executeInstruction(instruction, frame) {
    dispatch(frame, instruction, this);
  }

  loadClass(classFilePath, options = {}) {
    // For backwards compatibility, try sync first
    try {
      const classData = loadClassByPathSync(classFilePath, options);
      if (classData) {
        this.classes[classData.classes[0].className] = classData;
      }
      return classData;
    } catch (error) {
      if (error.message.includes('Synchronous file operations not supported')) {
        // This is a browser environment - return a rejected promise or throw error
        // telling the caller to use loadClassAsync instead
        throw new Error('Use loadClassAsync() for browser environments');
      }
      // Re-throw other errors
      throw error;
    }
  }

  async loadClassAsync(classFilePath, options = {}) {
    // Try async first, fall back to sync for backwards compatibility
    try {
      const classData = await loadClassByPath(classFilePath, options);
      if (classData) {
        this.classes[classData.classes[0].className] = classData;
      }
      return classData;
    } catch (error) {
      // If async fails and we have a sync provider, try sync method
      try {
        const classData = loadClassByPathSync(classFilePath, options);
        if (classData) {
          this.classes[classData.classes[0].className] = classData;
        }
        return classData;
      } catch (syncError) {
        // If both fail, throw the original async error
        throw error;
      }
    }
  }

  loadClassSync(classFilePath, options = {}) {
    try {
      const classData = loadClassByPathSync(classFilePath, options);
      if (classData) {
        this.classes[classData.classes[0].className] = classData;
      }
      return classData;
    } catch (error) {
      // If sync fails, for browser environments, just return null 
      // and let the caller handle the missing class
      console.warn(`Could not load class ${classFilePath} synchronously:`, error.message);
      return null;
    }
  }

  findMainMethod(classData) {
    const mainMethod = classData.classes[0].items.find(item => {
      return item.type === 'method' &&
             item.method.name === 'main' &&
             item.method.descriptor === '([Ljava/lang/String;)V';
    });
    return mainMethod ? mainMethod.method : null;
  }

  findMethod(classData, methodName, descriptor) {
    const method = classData.classes[0].items.find(item => {
      return item.type === 'method' &&
             item.method.name === methodName &&
             item.method.descriptor === descriptor;
    });
    return method ? method.method : null;
  }

  handleException(exception, pc) {
    if (this.callStack.isEmpty()) {
      console.error('Unhandled exception:', exception);
      return;
    }
    const frame = this.callStack.peek();

    let pcToCheck = pc;
    if (pc === -1) {
      // Unwinding from a called method. The pc is the one of the call site.
      const callerInstructionIndex = frame.pc - 1;
      if (callerInstructionIndex >= 0) {
        const instructionItem = frame.instructions[callerInstructionIndex];
        const label = instructionItem.labelDef;
        pcToCheck = label ? parseInt(label.substring(1, label.length - 1)) : -1;
      }
    }

    const table = frame.exceptionTable;
    if (table) {
      for (const entry of table) {
        if (pcToCheck >= entry.start_pc && pcToCheck < entry.end_pc) {
          if (entry.catch_type === 'any' || entry.catch_type === exception.type) {
            const targetIndex = frame.instructions.findIndex(inst => {
              if (!inst.labelDef) return false;
              const labelPc = parseInt(inst.labelDef.substring(1, inst.labelDef.length - 1));
              return labelPc === entry.handler_pc;
            });

            if (targetIndex !== -1) {
              frame.stack.clear();
              frame.stack.push(exception);
              frame.pc = targetIndex;
              return;
            }
          }
        }
      }
    }

    this.callStack.pop();
    this.handleException(exception, -1); // PC is -1 for subsequent frames
  }

  // Serialization methods
  serialize() {
    const frames = [];
    const callStackItems = [...this.callStack.items];
    
    for (const frame of callStackItems) {
      frames.push({
        method: {
          name: frame.method.name,
          descriptor: frame.method.descriptor,
          accessFlags: frame.method.accessFlags,
          attributes: frame.method.attributes
        },
        stack: [...frame.stack.items],
        locals: [...frame.locals],
        pc: frame.pc,
        // Store instructions and exception table references
        methodRef: {
          className: this.findClassNameForMethod(frame.method),
          methodName: frame.method.name,
          methodDescriptor: frame.method.descriptor
        }
      });
    }

    return {
      frames: frames,
      classes: this.classes,
      debugMode: this.debugMode,
      breakpoints: Array.from(this.breakpoints),
      stepMode: this.stepMode,
      stepTargetDepth: this.stepTargetDepth,
      stepTargetFrame: this.stepTargetFrame
    };
  }

  deserialize(state) {
    // Clear current state
    this.callStack.clear();
    this.classes = state.classes || {};
    this.debugMode = state.debugMode || false;
    this.breakpoints = new Set(state.breakpoints || []);
    this.stepMode = state.stepMode || null;
    this.stepTargetDepth = state.stepTargetDepth || null;
    this.stepTargetFrame = state.stepTargetFrame || null;

    // Reconstruct call stack
    for (const frameData of state.frames || []) {
      // Find the method in loaded classes
      const method = this.findMethodByRef(frameData.methodRef);
      if (!method) {
        throw new Error(`Cannot find method ${frameData.methodRef.className}.${frameData.methodRef.methodName}${frameData.methodRef.methodDescriptor}`);
      }

      const frame = new Frame(method);
      frame.stack.items = [...frameData.stack];
      frame.locals = [...frameData.locals];
      frame.pc = frameData.pc;
      
      this.callStack.push(frame);
    }
  }

  findClassNameForMethod(method) {
    // Helper method to find which class contains a given method
    for (const [className, classData] of Object.entries(this.classes)) {
      if (classData && classData.classes && classData.classes[0]) {
        const methods = classData.classes[0].items.filter(item => item.type === 'method');
        if (methods.some(item => item.method === method)) {
          return className;
        }
      }
    }
    return null;
  }

  findMethodByRef(methodRef) {
    // Find method by class name, method name, and descriptor
    const classData = this.classes[methodRef.className];
    if (!classData || !classData.classes || !classData.classes[0]) {
      return null;
    }

    const methodItem = classData.classes[0].items.find(item => {
      return item.type === 'method' &&
             item.method.name === methodRef.methodName &&
             item.method.descriptor === methodRef.methodDescriptor;
    });
    
    return methodItem ? methodItem.method : null;
  }

  // Debug control methods
  enableDebugMode() {
    this.debugMode = true;
  }

  disableDebugMode() {
    this.debugMode = false;
    this.stepMode = null;
  }

  addBreakpoint(pc) {
    this.breakpoints.add(pc);
  }

  removeBreakpoint(pc) {
    this.breakpoints.delete(pc);
  }

  clearBreakpoints() {
    this.breakpoints.clear();
  }

  stepInto() {
    this.stepMode = 'into';
    this.stepTargetDepth = this.callStack.size();
  }

  stepOver() {
    this.stepMode = 'over';
    this.stepTargetDepth = this.callStack.size();
  }

  stepOut() {
    this.stepMode = 'out';
    this.stepTargetDepth = this.callStack.size();
  }

  stepInstruction() {
    this.stepMode = 'instruction';
  }

  finish() {
    this.stepMode = 'finish';
    this.stepTargetFrame = this.callStack.peek();
  }

  continue() {
    this.stepMode = null;
    this.stepTargetDepth = null;
    this.stepTargetFrame = null;
  }

  getCurrentState() {
    if (this.callStack.isEmpty()) {
      return {
        pc: null,
        frame: null,
        stack: [],
        locals: [],
        callStackDepth: 0
      };
    }

    const frame = this.callStack.peek();
    // Get the current PC from the current instruction's label
    const currentInstructionItem = frame.instructions[frame.pc < frame.instructions.length ? frame.pc : frame.pc - 1];
    const label = currentInstructionItem ? currentInstructionItem.labelDef : null;
    const currentPc = label ? parseInt(label.substring(1, label.length - 1)) : -1;

    return {
      pc: currentPc,
      frame: frame,
      stack: [...frame.stack.items],
      locals: [...frame.locals],
      callStackDepth: this.callStack.size(),
      method: {
        name: frame.method.name,
        descriptor: frame.method.descriptor
      }
    };
  }

  /**
   * Get a detailed backtrace showing all frames with arguments and local variables
   * @returns {Array} Array of frame information with method details and variables
   */
  getBacktrace() {
    if (this.callStack.isEmpty()) {
      return [];
    }

    const frames = [];
    const stackItems = this.callStack.items;
    
    for (let i = stackItems.length - 1; i >= 0; i--) {
      const frame = stackItems[i];
      const frameInfo = this._getFrameInfo(frame, i);
      frames.push(frameInfo);
    }
    
    return frames;
  }

  /**
   * Get detailed information about a specific frame
   * @param {Frame} frame - The frame to analyze
   * @param {number} frameIndex - Index of the frame in the call stack
   * @returns {object} Detailed frame information
   */
  _getFrameInfo(frame, frameIndex) {
    // Get current PC for this frame
    const currentInstructionItem = frame.instructions[frame.pc < frame.instructions.length ? frame.pc : frame.pc - 1];
    const label = currentInstructionItem ? currentInstructionItem.labelDef : null;
    const currentPc = label ? parseInt(label.substring(1, label.length - 1)) : -1;
    
    // Parse method descriptor to understand arguments
    const { params, returnType } = parseDescriptor(frame.method.descriptor);
    
    // Get method arguments from local variables
    const methodArgs = this._extractMethodArguments(frame, params);
    
    // Get local variable information
    const localVariables = this._getLocalVariableInfo(frame);
    
    // Get source line mapping
    const sourceMapping = this.getSourceLineMapping(currentPc, frame.method);
    
    // Find class name for this method
    const className = this.findClassNameForMethod(frame.method);
    
    // Get total stack size for isCurrentFrame check
    const totalFrames = this.callStack.size();
    
    return {
      frameIndex: frameIndex,
      className: className || 'Unknown',
      methodName: frame.method.name,
      methodDescriptor: frame.method.descriptor,
      pc: currentPc,
      sourceLine: sourceMapping.line,
      sourceFile: sourceMapping.sourceFile,
      arguments: methodArgs,
      localVariables: localVariables,
      stack: [...frame.stack.items],
      returnType: returnType,
      isCurrentFrame: frameIndex === totalFrames - 1
    };
  }

  /**
   * Extract method arguments from local variables based on method descriptor
   * @param {Frame} frame - The frame to analyze
   * @param {Array} params - Parameter types from method descriptor
   * @returns {Array} Method arguments with names and values
   */
  _extractMethodArguments(frame, params) {
    const args = [];
    let localIndex = 0;
    
    // Check if method is static by looking at method flags
    const isStatic = frame.method.flags && frame.method.flags.includes('static');
    
    // For non-static methods, local 0 is 'this'
    if (!isStatic) {
      args.push({
        name: 'this',
        type: 'reference',
        value: frame.locals[0],
        localIndex: 0
      });
      localIndex = 1;
    }
    
    // Extract parameters
    for (let i = 0; i < params.length; i++) {
      const paramType = params[i];
      const value = frame.locals[localIndex];
      
      args.push({
        name: `arg${i}`,
        type: paramType,
        value: value,
        localIndex: localIndex
      });
      
      // Long and double take up 2 local variable slots
      if (paramType === 'long' || paramType === 'double') {
        localIndex += 2;
      } else {
        localIndex += 1;
      }
    }
    
    return args;
  }

  /**
   * Get information about all local variables in a frame
   * @param {Frame} frame - The frame to analyze
   * @returns {Array} Local variable information
   */
  _getLocalVariableInfo(frame) {
    const variables = [];
    
    // Try to get variable names from LocalVariableTable if available
    const localVarTable = this._getLocalVariableTable(frame.method);
    
    for (let i = 0; i < frame.locals.length; i++) {
      const value = frame.locals[i];
      let varInfo = {
        index: i,
        value: value,
        type: this._inferType(value),
        name: `local_${i}`
      };
      
      // If we have debug info, use the actual variable name
      if (localVarTable) {
        const varEntry = localVarTable.find(entry => entry.index === i);
        if (varEntry) {
          varInfo.name = varEntry.name;
          varInfo.type = varEntry.signature || varInfo.type;
        }
      }
      
      variables.push(varInfo);
    }
    
    return variables;
  }

  /**
   * Get LocalVariableTable from method attributes
   * @param {object} method - Method object
   * @returns {Array|null} Local variable table entries
   */
  _getLocalVariableTable(method) {
    if (!method.attributes) return null;
    
    const codeAttribute = method.attributes.find(attr => attr.type === 'code');
    if (!codeAttribute || !codeAttribute.code.attributes) return null;
    
    const localVarTable = codeAttribute.code.attributes.find(attr => attr.type === 'localvariabletable');
    return localVarTable ? localVarTable.variables : null;
  }

  /**
   * Infer the type of a value
   * @param {*} value - The value to analyze
   * @returns {string} Inferred type
   */
  _inferType(value) {
    if (value === null || value === undefined) {
      return 'null';
    } else if (typeof value === 'number') {
      return Number.isInteger(value) ? 'int' : 'double';
    } else if (typeof value === 'string') {
      return 'String';
    } else if (typeof value === 'boolean') {
      return 'boolean';
    } else if (Array.isArray(value)) {
      return 'array';
    } else if (typeof value === 'object') {
      return value.type || 'object';
    } else {
      return typeof value;
    }
  }

  /**
   * Inspect the current execution stack with detailed type information
   * @returns {Array} Stack values with type and index information
   */
  inspectStack() {
    if (this.callStack.isEmpty()) {
      return [];
    }
    
    const frame = this.callStack.peek();
    const stackItems = frame.stack.items;
    
    return stackItems.map((value, index) => ({
      index: index,
      value: value,
      type: this._inferType(value),
      description: this._getValueDescription(value)
    }));
  }

  /**
   * Inspect local variables with detailed information
   * @returns {Array} Local variables with names, types, and values
   */
  inspectLocals() {
    if (this.callStack.isEmpty()) {
      return [];
    }
    
    const frame = this.callStack.peek();
    return this._getLocalVariableInfo(frame);
  }

  /**
   * Inspect a specific local variable by index
   * @param {number} index - Local variable index
   * @returns {object|null} Variable information or null if not found
   */
  inspectLocalVariable(index) {
    if (this.callStack.isEmpty()) {
      return null;
    }
    
    const frame = this.callStack.peek();
    if (index < 0 || index >= frame.locals.length) {
      return null;
    }
    
    const value = frame.locals[index];
    const localVarTable = this._getLocalVariableTable(frame.method);
    let name = `local_${index}`;
    let signature = this._inferType(value);
    
    if (localVarTable) {
      const varEntry = localVarTable.find(entry => entry.index === index);
      if (varEntry) {
        name = varEntry.name;
        signature = varEntry.signature || signature;
      }
    }
    
    return {
      index: index,
      name: name,
      value: value,
      type: signature,
      description: this._getValueDescription(value)
    };
  }

  /**
   * Inspect a specific stack value by index
   * @param {number} index - Stack index (0 = bottom, -1 = top)
   * @returns {object|null} Stack value information or null if not found
   */
  inspectStackValue(index) {
    if (this.callStack.isEmpty()) {
      return null;
    }
    
    const frame = this.callStack.peek();
    const stackItems = frame.stack.items;
    
    // Handle negative indices (from top)
    const actualIndex = index < 0 ? stackItems.length + index : index;
    
    if (actualIndex < 0 || actualIndex >= stackItems.length) {
      return null;
    }
    
    const value = stackItems[actualIndex];
    return {
      index: actualIndex,
      value: value,
      type: this._inferType(value),
      description: this._getValueDescription(value)
    };
  }

  /**
   * Inspect an object's fields if the value is an object reference
   * @param {*} objRef - Object reference to inspect
   * @returns {object|null} Object field information or null if not an object
   */
  inspectObject(objRef) {
    if (!objRef || typeof objRef !== 'object' || Array.isArray(objRef)) {
      return null;
    }
    
    const result = {
      type: objRef.type || 'object',
      fields: [],
      methods: []
    };
    
    // Inspect object fields
    if (objRef.fields) {
      for (const [fieldName, fieldValue] of Object.entries(objRef.fields)) {
        result.fields.push({
          name: fieldName,
          value: fieldValue,
          type: this._inferType(fieldValue),
          description: this._getValueDescription(fieldValue)
        });
      }
    }
    
    // Add any other properties as fields
    for (const [key, value] of Object.entries(objRef)) {
      if (key !== 'type' && key !== 'fields') {
        result.fields.push({
          name: key,
          value: value,
          type: this._inferType(value),
          description: this._getValueDescription(value)
        });
      }
    }
    
    return result;
  }

  /**
   * Find a variable by name in the current frame
   * @param {string} name - Variable name to search for
   * @returns {object|null} Variable information or null if not found
   */
  findVariableByName(name) {
    if (this.callStack.isEmpty()) {
      return null;
    }
    
    const frame = this.callStack.peek();
    const localVarTable = this._getLocalVariableTable(frame.method);
    
    if (!localVarTable) {
      return null;
    }
    
    const varEntry = localVarTable.find(entry => entry.name === name);
    if (!varEntry) {
      return null;
    }
    
    return this.inspectLocalVariable(varEntry.index);
  }

  /**
   * Get all available variable names in the current frame
   * @returns {Array} List of variable names
   */
  getAvailableVariableNames() {
    if (this.callStack.isEmpty()) {
      return [];
    }
    
    const frame = this.callStack.peek();
    const localVarTable = this._getLocalVariableTable(frame.method);
    
    if (!localVarTable) {
      // Return generic local variable names
      return frame.locals.map((_, index) => `local_${index}`);
    }
    
    return localVarTable.map(entry => entry.name);
  }

  /**
   * Get a human-readable description of a value
   * @param {*} value - The value to describe
   * @returns {string} Human-readable description
   */
  _getValueDescription(value) {
    if (value === null || value === undefined) {
      return 'null';
    } else if (typeof value === 'number') {
      return `${value} (${Number.isInteger(value) ? 'integer' : 'floating-point'})`;
    } else if (typeof value === 'string') {
      return `"${value}" (String, length: ${value.length})`;
    } else if (typeof value === 'boolean') {
      return `${value} (boolean)`;
    } else if (Array.isArray(value)) {
      return `Array[${value.length}] (${value.map(v => this._inferType(v)).join(', ')})`;
    } else if (typeof value === 'object') {
      const type = value.type || 'Object';
      const fieldCount = value.fields ? Object.keys(value.fields).length : Object.keys(value).length - 1;
      return `${type} instance (${fieldCount} fields)`;
    } else {
      return `${value} (${typeof value})`;
    }
  }

  /**
   * Get source line mapping for a given PC
   * @param {number} pc - Program counter value
   * @param {object} method - Method object containing line number table
   * @returns {object} Source line information
   */
  getSourceLineMapping(pc, method) {
    if (!method || !method.attributes) {
      return { line: null, sourceFile: null, instruction: null };
    }

    const codeAttribute = method.attributes.find(attr => attr.type === 'code');
    if (!codeAttribute || !codeAttribute.code.attributes) {
      return { line: null, sourceFile: null, instruction: null };
    }

    const lineNumberTable = codeAttribute.code.attributes.find(attr => attr.type === 'linenumbertable');
    if (!lineNumberTable || !lineNumberTable.lines) {
      return { line: null, sourceFile: null, instruction: null };
    }

    // Find the appropriate line number for this PC
    let lineNumber = null;
    for (const lineEntry of lineNumberTable.lines) {
      const linePc = parseInt(lineEntry.label.substring(1)); // Remove 'L' prefix
      if (linePc <= pc) {
        lineNumber = parseInt(lineEntry.lineNumber);
      } else {
        break;
      }
    }

    // Get the instruction at this PC
    const instructionItem = codeAttribute.code.codeItems.find(item => {
      const label = item.labelDef;
      if (label) {
        const itemPc = parseInt(label.substring(1, label.length - 1));
        return itemPc === pc;
      }
      return false;
    });

    const instruction = instructionItem ? instructionItem.instruction : null;
    const instructionText = formatInstruction(instruction);

    return {
      line: lineNumber,
      sourceFile: this.getSourceFileName(method),
      instruction: instructionText,
      pc: pc
    };
  }

  /**
   * Get source file name from method's class
   * @param {object} method - Method object
   * @returns {string} Source file name
   */
  getSourceFileName(method) {
    // Try to get from the loaded class data
    for (const className in this.classes) {
      const classData = this.classes[className];
      if (classData.classes && classData.classes[0] && classData.classes[0].items) {
        const sourceFileAttr = classData.classes[0].items.find(item => 
          item.type === 'attribute' && item.attribute.type === 'sourcefile'
        );
        if (sourceFileAttr) {
          return sourceFileAttr.attribute.value.replace(/"/g, '');
        }
      }
    }
    return null;
  }



  /**
   * Get disassembly view with current execution position highlighted
   * @returns {object} Disassembly information
   */
  getDisassemblyView() {
    if (this.callStack.isEmpty()) {
      return { 
        formattedDisassembly: 'No active execution frame',
        currentPc: null, 
        sourceMapping: null,
        classFile: null
      };
    }

    const frame = this.callStack.peek();
    const method = frame.method;
    
    // Get current PC from the instruction
    const currentInstructionItem = frame.instructions[frame.pc < frame.instructions.length ? frame.pc : frame.pc - 1];
    const currentLabel = currentInstructionItem ? currentInstructionItem.labelDef : null;
    const currentPc = currentLabel ? parseInt(currentLabel.substring(1, currentLabel.length - 1)) : -1;
    
    // Find the class data that contains this method
    let classData = null;
    let classFile = null;
    for (const [className, data] of Object.entries(this.classes)) {
      if (data && data.classes && data.classes[0]) {
        const methods = data.classes[0].items.filter(item => item.type === 'method');
        if (methods.some(item => item.method === method)) {
          classData = data.classes[0];
          classFile = className;
          break;
        }
      }
    }

    if (!classData) {
      return { 
        formattedDisassembly: 'Class data not found for current method',
        currentPc: currentPc, 
        sourceMapping: null,
        classFile: null
      };
    }

    // Get complete disassembly using unparseDataStructures
    const completeDisassembly = unparseDataStructures(classData);
    
    // Split into lines and add line numbers
    const lines = completeDisassembly.split('\n');
    
    // Find which line contains the current PC label within the current method context
    let currentPcLineIndex = -1;
    const currentPcLabel = `L${currentPc}:`;
    const currentMethodName = method.name;
    const currentMethodDescriptor = method.descriptor;
    
    // Find the method section first
    let inCurrentMethod = false;
    let methodStartIndex = -1;
    let methodEndIndex = -1;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes(`.method`) && line.includes(currentMethodName) && line.includes(currentMethodDescriptor)) {
        inCurrentMethod = true;
        methodStartIndex = i;
      } else if (inCurrentMethod && line.includes(`.end method`)) {
        methodEndIndex = i;
        break;
      }
    }
    
    // Now search for the PC label within this method
    if (methodStartIndex !== -1 && methodEndIndex !== -1) {
      for (let i = methodStartIndex; i <= methodEndIndex; i++) {
        if (lines[i].includes(currentPcLabel)) {
          currentPcLineIndex = i;
          break;
        }
      }
    }

    // Format the disassembly with line numbers and current position marker
    const numberedLines = lines.map((line, index) => {
      const lineNumber = String(index + 1).padStart(4, ' ');
      const marker = index === currentPcLineIndex ? '=>' : '  ';
      return `${marker} ${lineNumber}  ${line}`;
    });

    // Get source mapping for current PC
    const currentSourceMapping = this.getSourceLineMapping(currentPc, method);
    
    // Create header and footer
    const sourceLineInfo = currentPcLineIndex !== -1 ? 
      ` (at line ${currentPcLineIndex + 1})` : '';
    
    const header = [
      '8. Disassembly View',
      '================================================================================',
      `File: ${classFile}`,
      `Current PC: ${currentPc}${sourceLineInfo}`,
      ''
    ];
    
    const footer = [
      '================================================================================'
    ];

    const formattedDisassembly = [
      ...header,
      ...numberedLines,
      ...footer
    ].join('\n');

    return {
      formattedDisassembly: formattedDisassembly,
      currentPc: currentPc,
      sourceMapping: currentSourceMapping,
      classFile: classFile,
      currentLineNumber: currentPcLineIndex + 1
    };
  }
}

module.exports = { JVM };

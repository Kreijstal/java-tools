const Stack = require('./stack');
const { loadClass, loadClassByPath, loadClassByPathSync } = require('./classLoader');
const { parseDescriptor } = require('./typeParser');
const { formatInstruction, unparseDataStructures } = require('./convert_tree');
const jreMethods = require('./jre');
const dispatch = require('./instructions');
const Frame = require('./frame');
const DebugManager = require('./DebugManager');

class JVM {
  constructor(options = {}) {
    this.threads = [];
    this.currentThreadIndex = 0;
    this.classes = {};
    this.jre = {};
    this.debugManager = new DebugManager();
    this.classpath = options.classpath || '.';

    this._jreMethods = jreMethods;
  }

  internString(str) {
    return str;
  }

  registerJreMethods(methods) {
    this._jreMethods = { ...this._jreMethods, ...methods };
  }

  async run(classFilePath, options = {}) {
    if (options.classpath) {
      this.classpath = options.classpath;
    }
    const classData = await this.loadClassAsync(classFilePath, options);
    if (!classData) {
      throw new Error(`Class not found: ${classFilePath}`);
    }

    const mainMethod = this.findMainMethod(classData);
    if (!mainMethod) {
      console.error('main method not found');
      return;
    }

    const mainThread = {
      id: 0,
      callStack: new Stack(),
      status: 'runnable',
    };
    const initialFrame = new Frame(mainMethod);
    mainThread.callStack.push(initialFrame);
    this.threads.push(mainThread);

    if (!this.debugManager.debugMode || !this.debugManager.isPaused) {
        await this.execute();
    }
  }

  async execute() {
    this.debugManager.resume();

    while (!this.debugManager.isPaused) {
      const result = await this.executeTick();
      if (result.completed) {
        this.debugManager.pause();
        return { completed: true, paused: false };
      }

      // Check for breakpoints
      const currentThread = this.threads[this.currentThreadIndex];
      if (currentThread && currentThread.status === 'runnable' && !currentThread.callStack.isEmpty()) {
          const frame = currentThread.callStack.peek();
          if (frame) {
              // A thread's pc can be out of bounds if it just finished.
              if (frame.pc < frame.instructions.length) {
                const instructionItem = frame.instructions[frame.pc];
                if (instructionItem) {
                    const label = instructionItem.labelDef;
                    const currentPc = label ? parseInt(label.substring(1, label.length - 1)) : -1;
                    if (this.debugManager.breakpoints.has(currentPc)) {
                        this.debugManager.pause();
                    }
                }
              }
          }
      }
      // Yield to the event loop to prevent blocking on long-running code without breakpoints
      await new Promise(resolve => setImmediate(resolve));
    }

    return { paused: true, completed: false };
  }

  async executeTick() {
    if (this.threads.filter(t => t.status === 'runnable').length === 0) {
      return { completed: true };
    }

    const thread = this.threads[this.currentThreadIndex];

    if (!thread || thread.status !== 'runnable') {
      this.currentThreadIndex = (this.currentThreadIndex + 1) % this.threads.length;
      return { completed: false };
    }

    const callStack = thread.callStack;

    if (callStack.isEmpty()) {
      thread.status = 'terminated';
      this.currentThreadIndex = (this.currentThreadIndex + 1) % this.threads.length;
      return { completed: false };
    }

    const frame = callStack.peek();
    if (frame.pc >= frame.instructions.length) {
      callStack.pop();
      return { completed: false };
    }

    const instructionItem = frame.instructions[frame.pc];
    const instruction = instructionItem.instruction;

    frame.pc++;

    try {
      if (instruction) {
        await this.executeInstruction(instruction, frame, thread);
      }
    } catch (e) {
      const label = instructionItem.labelDef;
      const currentPc = label ? parseInt(label.substring(1, label.length - 1)) : -1;
      this.handleException(e, currentPc, thread);
    }

    // Advance to next thread
    if (this.threads.length > 0) {
      this.currentThreadIndex = (this.currentThreadIndex + 1) % this.threads.length;
    }

    return { completed: false };
  }

  // TODO: Make debugger thread-aware
  shouldPause(currentPc, frame) {
    return false;
  }

  shouldPauseAfterStep(currentPc, frame) {
    return false;
  }

  async executeInstruction(instruction, frame, thread) {
    await dispatch(frame, instruction, this, thread);
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

  async loadClassByName(classNameWithSlashes) {
    if (this.classes[classNameWithSlashes]) {
      return this.classes[classNameWithSlashes];
    }
    const classNameWithDots = classNameWithSlashes.replace(/\//g, '.');
    const classData = await loadClass(classNameWithDots, this.classpath);
    if (classData) {
      this.classes[classData.classes[0].className] = classData;
    }
    return classData;
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

  findMethodInHierarchy(className, methodName, descriptor) {
    let currentClassName = className;
    while (currentClassName) {
      const classData = this.classes[currentClassName];
      if (classData) {
          const method = this.findMethod(classData, methodName, descriptor);
          if (method) {
              return method;
          }
      } else {
        return null;
      }
      currentClassName = classData.classes[0].superClassName;
    }
    return null;
  }

  handleException(exception, pc, thread) {
    const callStack = thread.callStack;
    if (callStack.isEmpty()) {
      console.error('Unhandled exception:', exception);
      return;
    }
    const frame = callStack.peek();

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

    callStack.pop();
    this.handleException(exception, -1, thread); // PC is -1 for subsequent frames
  }

  serialize() {
    return {
      debugManager: this.debugManager.serialize(),
    };
  }

  deserialize(state) {
    if (state && state.debugManager) {
      this.debugManager.deserialize(state.debugManager);
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

  // Thread-aware debugging and inspection methods

  enableDebugMode() { this.debugManager.enable(); }
  disableDebugMode() { this.debugManager.disable(); }
  addBreakpoint(pc) { this.debugManager.addBreakpoint(pc); }
  removeBreakpoint(pc) { this.debugManager.removeBreakpoint(pc); }
  clearBreakpoints() { this.debugManager.clearBreakpoints(); }

  getCurrentState() {
    const thread = this.threads[this.currentThreadIndex];
    if (!thread || thread.callStack.isEmpty()) return { callStackDepth: 0 };
    const frame = thread.callStack.peek();
    if (!frame) return { callStackDepth: thread.callStack.size() };

    const instructionItem = frame.instructions[frame.pc];
    const label = instructionItem ? instructionItem.labelDef : null;
    const currentPc = label ? parseInt(label.substring(1, label.length - 1)) : -1;

    return {
        pc: currentPc,
        stack: frame.stack.items,
        locals: frame.locals,
        callStackDepth: thread.callStack.size(),
        method: { name: frame.method.name, descriptor: frame.method.descriptor },
    };
  }

  getBacktrace(threadId = this.debugManager.selectedThreadId) {
    const thread = this.threads[threadId];
    if (!thread) return [];
    return thread.callStack.items.map((frame, i) => this._getFrameInfo(frame, i, thread.callStack.size()));
  }

  _getFrameInfo(frame, frameIndex, totalFrames) {
    const className = this.findClassNameForMethod(frame.method);
    const { params } = parseDescriptor(frame.method.descriptor);
    const args = this._extractMethodArguments(frame, params);
    return {
        frameIndex: frameIndex,
        className: className,
        methodName: frame.method.name,
        methodDescriptor: frame.method.descriptor,
        isCurrentFrame: frameIndex === (totalFrames - 1),
        arguments: args,
    };
  }

  _extractMethodArguments(frame, params) {
    const args = [];
    let localIndex = 0;
    const isStatic = frame.method.flags && frame.method.flags.includes('static');
    if (!isStatic) {
      args.push({ name: 'this', type: 'reference', value: frame.locals[0], localIndex: 0 });
      localIndex = 1;
    }
    for (let i = 0; i < params.length; i++) {
      const paramType = params[i];
      args.push({ name: `arg${i}`, type: paramType, value: frame.locals[localIndex], localIndex: localIndex });
      if (paramType === 'long' || paramType === 'double') {
        localIndex += 2;
      } else {
        localIndex += 1;
      }
    }
    return args;
  }

  inspectStack(threadId = this.debugManager.selectedThreadId) {
    const thread = this.threads[threadId];
    if (!thread || thread.callStack.isEmpty()) return [];
    return thread.callStack.peek().stack.items.map((value, index) => ({
        index, value, type: this._inferType(value)
    }));
  }

  inspectLocals(threadId = this.debugManager.selectedThreadId) {
    const thread = this.threads[threadId];
    if (!thread || thread.callStack.isEmpty()) return [];
    return this._getLocalVariableInfo(thread.callStack.peek());
  }

  _getLocalVariableInfo(frame) {
    const variables = [];
    const localVarTable = this._getLocalVariableTable(frame.method);
    for (let i = 0; i < frame.locals.length; i++) {
      const value = frame.locals[i];
      let varInfo = {
        index: i,
        value: value,
        type: this._inferType(value),
        name: `local_${i}`
      };
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

  _getLocalVariableTable(method) {
    if (!method.attributes) return null;
    const codeAttribute = method.attributes.find(attr => attr.type === 'code');
    if (!codeAttribute || !codeAttribute.code.attributes) return null;
    const localVarTable = codeAttribute.code.attributes.find(attr => attr.type === 'localvariabletable');
    return localVarTable ? localVarTable.variables : null;
  }

  _inferType(value) {
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'double';
    if (typeof value === 'string') return 'String';
    if (typeof value === 'boolean') return 'boolean';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'object') return value.type || 'object';
    return typeof value;
  }

  inspectLocalVariable(index, threadId = this.debugManager.selectedThreadId) {
    const locals = this.inspectLocals(threadId);
    return locals.find(l => l.index === index) || null;
  }

  inspectStackValue(index, threadId = this.debugManager.selectedThreadId) {
    const stack = this.inspectStack(threadId);
    if (index < 0) {
        index = stack.length + index;
    }
    return stack.find(s => s.index === index) || null;
  }

  getAvailableVariableNames(threadId = this.debugManager.selectedThreadId) {
      const locals = this.inspectLocals(threadId);
      return locals.map(l => l.name);
  }

  inspectObject(objRef) {
    if (!objRef || typeof objRef !== 'object') return null;
    return { type: objRef.type, fields: objRef.fields || {} };
  }

  // Placeholders for now
  stepInto() {}
  stepOver() {}
  stepOut() {}
  stepInstruction() {}
  finish() {}
  continue() {}
  findVariableByName(name) { return null; }
  _getValueDescription(value) { return ''; }
  getSourceLineMapping(pc, method) { return {}; }
  getSourceFileName(method) { return null; }
  getDisassemblyView() {
    // Get current execution state
    const thread = this.threads[this.currentThreadIndex];
    if (!thread || thread.callStack.isEmpty()) {
      return { 
        formattedDisassembly: '',
        lineToPcMap: {},
        classFile: null,
        currentPc: -1
      };
    }

    const frame = thread.callStack.peek();
    if (!frame) {
      return { 
        formattedDisassembly: '',
        lineToPcMap: {},
        classFile: null,
        currentPc: -1
      };
    }

    // Find the class that contains the current method
    const className = this.findClassNameForMethod(frame.method);
    if (!className) {
      return { 
        formattedDisassembly: '// Could not find class for current method',
        lineToPcMap: {},
        classFile: null,
        currentPc: -1
      };
    }

    const classData = this.classes[className];
    if (!classData) {
      return { 
        formattedDisassembly: '// Class data not available',
        lineToPcMap: {},
        classFile: className,
        currentPc: -1
      };
    }

    try {
      // Get current PC
      let currentPc = -1;
      if (frame.pc < frame.instructions.length) {
        const instructionItem = frame.instructions[frame.pc];
        const label = instructionItem ? instructionItem.labelDef : null;
        currentPc = label ? parseInt(label.substring(1, label.length - 1)) : -1;
      }

      // Generate disassembly using the same method as getClassDisassembly
      const disassembly = unparseDataStructures(classData.classes[0]);
      
      // Format the disassembly with debug information
      const formattedDisassembly = this._formatDisassemblyForDebugView(disassembly, currentPc, className);
      
      // Create line to PC mapping for breakpoint support
      const lineToPcMap = this._createLineToPcMap(disassembly, currentPc);
      
      return {
        formattedDisassembly: formattedDisassembly,
        lineToPcMap: lineToPcMap,
        classFile: `${className}.class`,
        currentPc: currentPc
      };
    } catch (error) {
      return { 
        formattedDisassembly: `// Error generating disassembly: ${error.message}`,
        lineToPcMap: {},
        classFile: `${className}.class`,
        currentPc: -1
      };
    }
  }

  _formatDisassemblyForDebugView(disassembly, currentPc, className) {
    // Format disassembly with debug header and current execution indicator
    const header = `8. Disassembly View
=====================================
File: ${className}.class
Current PC: ${currentPc}

`;
    
    const lines = disassembly.split('\n');
    const formattedLines = [];
    let lineNumber = 1;
    
    for (const line of lines) {
      // Check if this line contains a PC marker that matches the current PC
      const pcMatch = line.match(/L(\d+):/);
      const linePc = pcMatch ? parseInt(pcMatch[1]) : -1;
      
      if (linePc === currentPc) {
        // Mark current execution line with arrow
        formattedLines.push(`=>  ${lineNumber.toString().padStart(3)}  ${line}`);
      } else {
        // Regular line with line number
        formattedLines.push(`    ${lineNumber.toString().padStart(3)}  ${line}`);
      }
      lineNumber++;
    }
    
    const footer = '\n=====================================';
    
    return header + formattedLines.join('\n') + footer;
  }

  _createLineToPcMap(disassembly, currentPc) {
    // Create mapping from display line numbers to PC values for breakpoint support
    const lineToPcMap = {};
    const lines = disassembly.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const pcMatch = line.match(/L(\d+):/);
      if (pcMatch) {
        const pc = parseInt(pcMatch[1]);
        // The display line number will be i + 6 (accounting for header lines)
        const displayLineNumber = i + 5; // 5 header lines before content starts
        lineToPcMap[displayLineNumber] = pc;
      }
    }
    
    return lineToPcMap;
  }
}

module.exports = { JVM };

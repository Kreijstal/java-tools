const Stack = require('./stack');
const { loadClassByPath, loadClassByPathSync } = require('./classLoader');
const { parseDescriptor } = require('./typeParser');
const { formatInstruction, unparseDataStructures } = require('./convert_tree');
const jreMethods = require('./jre');
const dispatch = require('./instructions');
const Frame = require('./frame');

class JVM {
  constructor() {
    this.threads = [];
    this.currentThreadIndex = 0;
    this.classes = {};
    this.jre = {};
    // Debug state
    this.debugMode = false;
    this.breakpoints = new Set();
    this.stepMode = null; // null, 'into', 'over', 'out', 'instruction', 'finish'
    this.stepTargetDepth = null;
    this.stepTargetFrame = null;

    this._jreMethods = jreMethods;
  }

  internString(str) {
    return str;
  }

  registerJreMethods(methods) {
    this._jreMethods = { ...this._jreMethods, ...methods };
  }

  async run(classFilePath, options = {}) {
    const classData = this.loadClassSync(classFilePath, options);
    if (!classData) {
      return;
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

    await this.execute();
  }

  async execute() {
    // This is now the scheduler.
    // It runs as long as there are runnable threads.
    while (this.threads.filter(t => t.status === 'runnable').length > 0) {
      if (this.threads.length === 0) {
        break;
      }
      const thread = this.threads[this.currentThreadIndex];

      if (thread.status !== 'runnable') {
        this.currentThreadIndex = (this.currentThreadIndex + 1) % this.threads.length;
        await new Promise(resolve => setImmediate(resolve));
        continue;
      }

      const callStack = thread.callStack;

      if (callStack.isEmpty()) {
        thread.status = 'terminated';
        if (this.threads.filter(t => t.status === 'runnable').length === 0) {
          break;
        }
        this.currentThreadIndex = (this.currentThreadIndex + 1) % this.threads.length;
        continue;
      }

      const frame = callStack.peek();
      if (frame.pc >= frame.instructions.length) {
        callStack.pop();
        continue;
      }

      const instructionItem = frame.instructions[frame.pc];
      const instruction = instructionItem.instruction;

      // NOTE: Debugging features are temporarily disabled for threading implementation.

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

      // Simple round-robin scheduler.
      if (this.threads.length > 0) {
        this.currentThreadIndex = (this.currentThreadIndex + 1) % this.threads.length;
      }

      // Yield to the event loop.
      await new Promise(resolve => setImmediate(resolve));
    }
    
    // Execution completed
    return { paused: false, completed: true };
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

  // NOTE: Serialization is disabled for threaded JVM
  serialize() {
    return {};
  }

  deserialize(state) {
    // empty
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

  // NOTE: Debugging and inspection methods are disabled for threaded JVM.
  // A thread-aware implementation is required.

  // Debug control methods
  enableDebugMode() {}
  disableDebugMode() {}
  addBreakpoint(pc) {}
  removeBreakpoint(pc) {}
  clearBreakpoints() {}
  stepInto() {}
  stepOver() {}
  stepOut() {}
  stepInstruction() {}
  finish() {}
  continue() {}
  getCurrentState() { return {}; }
  getBacktrace() { return []; }
  _getFrameInfo(frame, frameIndex) { return {}; }
  _extractMethodArguments(frame, params) { return []; }
  _getLocalVariableInfo(frame) { return []; }
  _getLocalVariableTable(method) { return null; }
  _inferType(value) { return 'unknown'; }
  inspectStack() { return []; }
  inspectLocals() { return []; }
  inspectLocalVariable(index) { return null; }
  inspectStackValue(index) { return null; }
  inspectObject(objRef) { return null; }
  findVariableByName(name) { return null; }
  getAvailableVariableNames() { return []; }
  _getValueDescription(value) { return ''; }
  getSourceLineMapping(pc, method) { return {}; }
  getSourceFileName(method) { return null; }
  getDisassemblyView() { return {}; }
}

module.exports = { JVM };

const Stack = require('./stack');
const { loadClassByPath } = require('./classLoader');
const { parseDescriptor } = require('./typeParser');
const { formatInstruction } = require('./convert_tree');

class Frame {
  constructor(method) {
    this.method = method;
    this.stack = new Stack();
    const code = method.attributes.find(attr => attr.type === 'code').code;
    this.locals = new Array(parseInt(code.localsSize, 10)).fill(undefined);
    this.instructions = code.codeItems;
    this.exceptionTable = code.exceptionTable;
    this.pc = 0;
  }
}

class JVM {
  constructor() {
    this.callStack = new Stack();
    this.classes = {};
    this.jre = {
      'java/lang/System': {
        'out': {
          'java/io/PrintStream': {
            'println': (str) => {
              console.log(str);
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
  }

  run(classFilePath, options = {}) {
    const classData = this.loadClass(classFilePath, options);
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
    const op = typeof instruction === 'string' ? instruction : instruction.op;
    const arg = instruction.arg;

    switch (op) {
      case 'getstatic': {
        const [_, className, [fieldName, descriptor]] = arg;
        const field = this.jre[className][fieldName];
        frame.stack.push(field);
        break;
      }
      case 'ldc': {
        const value = arg.replace(/"/g, '');
        frame.stack.push(value);
        break;
      }
      case 'invokevirtual': {
        const [_, className, [methodName, descriptor]] = arg;
        const { params } = parseDescriptor(descriptor);
        const args = [];
        for (let i = 0; i < params.length; i++) {
          args.unshift(frame.stack.pop());
        }
        const obj = frame.stack.pop();
        
        // Handle built-in Java methods
        if (className === 'java/lang/String') {
          if (methodName === 'concat') {
            const result = obj + args[0];
            frame.stack.push(result);
            // console.log(`String.concat: "${obj}" + "${args[0]}" = "${result}"`);
          } else if (methodName === 'toUpperCase') {
            const result = obj.toUpperCase();
            frame.stack.push(result);
          } else if (methodName === 'toLowerCase') {
            const result = obj.toLowerCase();
            frame.stack.push(result);
          } else if (methodName === 'length') {
            const result = obj.length;
            frame.stack.push(result);
          } else {
            console.error(`Unsupported String method: ${methodName}`);
            // For unsupported methods, push a default return value to avoid stack underflow
            const { returnType } = parseDescriptor(descriptor);
            if (returnType === 'V') {
              // void return type, don't push anything
            } else if (returnType === 'Ljava/lang/String;') {
              frame.stack.push(obj); // return the original string
            } else {
              frame.stack.push(null); // default return value
            }
          }
        } else if (className === 'java/io/PrintStream') {
          if (methodName === 'println') {
            // Handle PrintStream.println method
            if (obj && obj['java/io/PrintStream'] && obj['java/io/PrintStream']['println']) {
              obj['java/io/PrintStream']['println'](...args);
            } else {
              console.log(...args);
            }
          } else {
            console.error(`Unsupported PrintStream method: ${methodName}`);
          }
        } else if (obj && obj[className] && obj[className][methodName]) {
          obj[className][methodName](...args);
        } else {
          console.error(`Unsupported invokevirtual: ${className}.${methodName}${descriptor}`);
        }
        break;
      }
      case 'return':
        this.callStack.pop();
        break;
      case 'bipush': {
        const value = parseInt(arg, 10);
        frame.stack.push(value);
        break;
      }
      case 'istore': {
        const index = parseInt(arg, 10);
        const value = frame.stack.pop();
        frame.locals[index] = value;
        // console.log(`istore ${index}: stored value ${value}`);
        break;
      }
      case 'iload': {
        const index = parseInt(arg, 10);
        const value = frame.locals[index];
        frame.stack.push(value);
        // console.log(`iload ${index}: loaded value ${value}`);
        break;
      }
      case 'iconst_m1':
        frame.stack.push(-1);
        break;
      case 'iconst_0':
        frame.stack.push(0);
        break;
      case 'iconst_1':
        frame.stack.push(1);
        break;
      case 'iconst_2':
        frame.stack.push(2);
        break;
      case 'iconst_3':
        frame.stack.push(3);
        break;
      case 'iconst_4':
        frame.stack.push(4);
        break;
      case 'iconst_5':
        frame.stack.push(5);
        break;
      case 'istore_0':
        frame.locals[0] = frame.stack.pop();
        break;
      case 'istore_1':
        frame.locals[1] = frame.stack.pop();
        break;
      case 'istore_2':
        frame.locals[2] = frame.stack.pop();
        break;
      case 'istore_3':
        frame.locals[3] = frame.stack.pop();
        break;
      case 'iload_0':
        frame.stack.push(frame.locals[0]);
        break;
      case 'iload_1':
        frame.stack.push(frame.locals[1]);
        break;
      case 'iload_2':
        frame.stack.push(frame.locals[2]);
        break;
      case 'iload_3':
        frame.stack.push(frame.locals[3]);
        break;
      case 'iadd': {
        const value2 = frame.stack.pop();
        const value1 = frame.stack.pop();
        frame.stack.push(value1 + value2);
        break;
      }
      case 'isub': {
        const value2 = frame.stack.pop();
        const value1 = frame.stack.pop();
        frame.stack.push(value1 - value2);
        break;
      }
      case 'imul': {
        const value2 = frame.stack.pop();
        const value1 = frame.stack.pop();
        frame.stack.push(value1 * value2);
        break;
      }
      case 'idiv': {
        const value2 = frame.stack.pop();
        const value1 = frame.stack.pop();
        if (value2 === 0) {
          throw { type: 'java/lang/ArithmeticException', message: '/ by zero' };
        }
        frame.stack.push(Math.floor(value1 / value2));
        break;
      }
      case 'irem': {
        const value2 = frame.stack.pop();
        const value1 = frame.stack.pop();
        frame.stack.push(value1 % value2);
        break;
      }
      case 'ireturn': {
        const returnValue = frame.stack.pop();
        this.callStack.pop();
        if (!this.callStack.isEmpty()) {
          this.callStack.peek().stack.push(returnValue);
        }
        break;
      }
      case 'invokestatic': {
        const [_, className, [methodName, descriptor]] = arg;
        let classData = this.classes[className];
        if (!classData) {
          const newClassPath = `sources/${className}.class`;
          classData = this.loadClass(newClassPath, { silent: true });
        }
        const method = this.findMethod(classData, methodName, descriptor);
        if (method) {
          const newFrame = new Frame(method);
          const { params } = parseDescriptor(descriptor);
          for (let i = params.length - 1; i >= 0; i--) {
            newFrame.locals[i] = frame.stack.pop();
          }
          this.callStack.push(newFrame);
        }
        break;
      }
      case 'aload_0':
        frame.stack.push(frame.locals[0]);
        break;
      case 'aload_1':
        frame.stack.push(frame.locals[1]);
        break;
      case 'aload_2':
        frame.stack.push(frame.locals[2]);
        break;
      case 'aload_3':
        frame.stack.push(frame.locals[3]);
        break;
      case 'astore_0':
        frame.locals[0] = frame.stack.pop();
        break;
      case 'astore_1':
        frame.locals[1] = frame.stack.pop();
        break;
      case 'astore_2':
        frame.locals[2] = frame.stack.pop();
        break;
      case 'astore_3':
        frame.locals[3] = frame.stack.pop();
        break;
      case 'dup':
        const topValue = frame.stack.peek();
        frame.stack.push(topValue);
        break;
      case 'pop':
        frame.stack.pop();
        break;
      case 'invokespecial': {
        const [_, className, [methodName, descriptor]] = arg;
        if (methodName === '<init>') {
          // Constructor call - for now just pop the object reference
          const { params } = parseDescriptor(descriptor);
          for (let i = 0; i < params.length; i++) {
            frame.stack.pop();
          }
          const objRef = frame.stack.pop(); // pop object reference
          // In a real JVM, this would initialize the object.
          // For now, we do nothing.
        }
        break;
      }
      case 'new': {
        const className = arg;
        // In a real JVM, this would be a more complex object representation.
        const objRef = { type: className, fields: {} };
        frame.stack.push(objRef);
        break;
      }
      case 'athrow': {
        const exception = frame.stack.pop();
        throw exception;
      }
      case 'astore': {
        const index = parseInt(arg, 10);
        const ref = frame.stack.pop();
        frame.locals[index] = ref;
        break;
      }
      case 'aload': {
        const index = parseInt(arg, 10);
        const ref = frame.locals[index];
        frame.stack.push(ref);
        break;
      }
      case 'astore_1':
          frame.locals[1] = frame.stack.pop();
          break;
      case 'areturn': {
        const returnValue = frame.stack.pop();
        this.callStack.pop();
        if (!this.callStack.isEmpty()) {
          this.callStack.peek().stack.push(returnValue);
        }
        break;
      }
      case 'goto': {
        const label = arg;
        const targetPc = frame.instructions.findIndex(inst => inst.labelDef === `${label}:`);
        if (targetPc !== -1) {
          frame.pc = targetPc;
        } else {
          throw new Error(`Label ${label} not found`);
        }
        break;
      }
      default:
        // console.log(`Unknown instruction: ${op}`);
    }
  }

  loadClass(classFilePath, options = {}) {
    const classData = loadClassByPath(classFilePath, options);
    if (classData) {
      this.classes[classData.classes[0].className] = classData;
    }
    return classData;
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
      return { instructions: [], currentPc: null, sourceMapping: null };
    }

    const frame = this.callStack.peek();
    const method = frame.method;
    const currentInstructionItem = frame.instructions[frame.pc < frame.instructions.length ? frame.pc : frame.pc - 1];
    const currentLabel = currentInstructionItem ? currentInstructionItem.labelDef : null;
    const currentPc = currentLabel ? parseInt(currentLabel.substring(1, currentLabel.length - 1)) : -1;

    const codeAttribute = method.attributes.find(attr => attr.type === 'code');
    if (!codeAttribute) {
      return { instructions: [], currentPc: currentPc, sourceMapping: null };
    }

    const instructions = codeAttribute.code.codeItems.map((item, index) => {
      const label = item.labelDef;
      const pc = label ? parseInt(label.substring(1, label.length - 1)) : -1;
      const instruction = formatInstruction(item.instruction);
      const isCurrentInstruction = pc === currentPc;
      const sourceMapping = this.getSourceLineMapping(pc, method);
      
      return {
        pc: pc,
        instruction: instruction,
        isCurrent: isCurrentInstruction,
        sourceMapping: sourceMapping,
        index: index
      };
    });

    const currentSourceMapping = this.getSourceLineMapping(currentPc, method);

    return {
      instructions: instructions,
      currentPc: currentPc,
      sourceMapping: currentSourceMapping,
      method: {
        name: method.name,
        descriptor: method.descriptor
      }
    };
  }
}

module.exports = { JVM, Frame };
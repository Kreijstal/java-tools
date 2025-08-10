const Stack = require('./stack');
const { loadClassByPath } = require('./classLoader');
const { parseDescriptor } = require('./typeParser');

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

  getCurrentInstruction() {
    return this.instructions[this.pc];
  }

  getState() {
    return {
      pc: this.pc,
      instruction: this.getCurrentInstruction(),
      stack: this.stack.items.slice(),
      locals: this.locals.slice(),
      method: {
        name: this.method.name,
        descriptor: this.method.descriptor,
        className: this.method.className
      }
    };
  }
}

class DebugJVM {
  constructor(options = {}) {
    this.callStack = new Stack();
    this.classes = {};
    this.stepCallback = options.stepCallback || null;
    this.executionTrace = [];
    this.isDebugging = options.debug || false;
    this.output = [];
    
    this.jre = {
      'java/lang/System': {
        'out': {
          'java/io/PrintStream': {
            'println': (str) => {
              this.output.push(str);
              if (!this.isDebugging) {
                console.log(str);
              }
            }
          }
        }
      }
    };
  }

  run(classFilePath, options = {}) {
    this.isDebugging = options.debug || false;
    this.output = [];
    this.executionTrace = [];
    
    const classData = this.loadClass(classFilePath, options);
    if (!classData) {
      return { success: false, error: 'Failed to load class' };
    }

    const mainMethod = this.findMainMethod(classData);
    if (!mainMethod) {
      return { success: false, error: 'main method not found' };
    }

    const initialFrame = new Frame(mainMethod);
    this.callStack.push(initialFrame);
    
    if (this.isDebugging) {
      return this.debugExecute();
    } else {
      this.execute();
      return { 
        success: true, 
        output: this.output,
        trace: this.executionTrace 
      };
    }
  }

  debugExecute() {
    const steps = [];
    
    while (!this.callStack.isEmpty()) {
      const currentState = this.getCurrentState();
      steps.push(currentState);
      
      if (this.stepCallback) {
        this.stepCallback(currentState);
      }
      
      if (!this.executeStep()) {
        break;
      }
    }
    
    return {
      success: true,
      steps: steps,
      output: this.output,
      trace: this.executionTrace
    };
  }

  getCurrentState() {
    if (this.callStack.isEmpty()) {
      return null;
    }
    
    const frame = this.callStack.peek();
    return {
      frameState: frame.getState(),
      callStackDepth: this.callStack.size(),
      output: this.output.slice(),
      timestamp: Date.now()
    };
  }

  executeStep() {
    if (this.callStack.isEmpty()) {
      return false;
    }

    const frame = this.callStack.peek();
    if (frame.pc >= frame.instructions.length) {
      this.callStack.pop();
      return !this.callStack.isEmpty();
    }

    const instruction = frame.instructions[frame.pc];
    
    // Record execution trace
    this.executionTrace.push({
      pc: frame.pc,
      instruction: instruction,
      stackBefore: frame.stack.items.slice(),
      localsBefore: frame.locals.slice()
    });

    try {
      this.executeInstruction(frame, instruction);
    } catch (error) {
      if (typeof error === 'object' && error.type) {
        this.handleException(frame, error);
      } else {
        throw error;
      }
    }

    frame.pc++;
    return true;
  }

  loadClass(classFilePath, options = {}) {
    try {
      const classData = loadClassByPath(classFilePath);
      if (classData && classData.name) {
        this.classes[classData.name] = classData;
      }
      return classData;
    } catch (error) {
      if (!options.silent) {
        console.error(`Failed to load class: ${error.message}`);
      }
      return null;
    }
  }

  findMainMethod(classData) {
    return classData.methods.find(method =>
      method.name === 'main' &&
      method.descriptor === '([Ljava/lang/String;)V' &&
      method.flags.includes('public') &&
      method.flags.includes('static')
    );
  }

  findMethod(classData, methodName, descriptor) {
    if (!classData || !classData.methods) {
      return null;
    }
    return classData.methods.find(method =>
      method.name === methodName && method.descriptor === descriptor
    );
  }

  execute() {
    while (!this.callStack.isEmpty()) {
      if (!this.executeStep()) {
        break;
      }
    }
  }

  executeInstruction(frame, instruction) {
    const [op, arg] = instruction;

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
            const { returnType } = parseDescriptor(descriptor);
            if (returnType === 'V') {
              // void return type, don't push anything
            } else if (returnType === 'Ljava/lang/String;') {
              frame.stack.push(obj);
            } else {
              frame.stack.push(null);
            }
          }
        } else if (className === 'java/io/PrintStream') {
          if (methodName === 'println') {
            this.jre['java/lang/System']['out']['java/io/PrintStream']['println'](args[0]);
          }
        }
        break;
      }
      case 'invokespecial': {
        // Handle constructor calls and private method calls
        const [_, className, [methodName, descriptor]] = arg;
        if (methodName === '<init>') {
          // Constructor call - for now, just pop the arguments
          const { params } = parseDescriptor(descriptor);
          for (let i = 0; i < params.length; i++) {
            frame.stack.pop();
          }
          frame.stack.pop(); // pop the object reference
        }
        break;
      }
      case 'return':
        this.callStack.pop();
        break;
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
      case 'aload': {
        const index = arg;
        frame.stack.push(frame.locals[index]);
        break;
      }
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
      case 'astore': {
        const index = arg;
        frame.locals[index] = frame.stack.pop();
        break;
      }
      case 'dup':
        const topValue = frame.stack.peek();
        frame.stack.push(topValue);
        break;
      case 'pop':
        frame.stack.pop();
        break;
      case 'sipush': {
        const value = parseInt(arg, 10);
        frame.stack.push(value);
        break;
      }
      default:
        console.log(`Unknown instruction: ${op}`);
        break;
    }
  }

  handleException(frame, error) {
    console.error(`Exception in ${frame.method.name}: ${error.type} - ${error.message}`);
    this.callStack.clear();
  }
}

module.exports = DebugJVM;
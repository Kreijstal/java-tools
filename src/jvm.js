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

      const instruction = frame.instructions[frame.pc].instruction;
      frame.pc++;

      if (instruction) {
        this.executeInstruction(instruction, frame);
      }
    }
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
        if (obj[className] && obj[className][methodName]) {
          obj[className][methodName](...args);
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
      case 'astore_0':
        frame.locals[0] = frame.stack.pop();
        break;
      case 'astore_1':
        frame.locals[1] = frame.stack.pop();
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
          frame.stack.pop(); // pop object reference
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
}

module.exports = JVM;
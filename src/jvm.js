const Stack = require('./stack');
const { loadClassByPath } = require('./classLoader');
const { parseDescriptor } = require('./typeParser');

class Frame {
  constructor(method) {
    this.method = method;
    this.stack = new Stack();
    const code = method.attributes.find(attr => attr.type === 'code').code;
    this.locals = new Array(parseInt(code.localsSize, 10));
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
      case 'iconst_2':
        frame.stack.push(2);
        break;
      case 'iconst_4':
        frame.stack.push(4);
        break;
      case 'istore_1':
        frame.locals[1] = frame.stack.pop();
        break;
      case 'iload_0':
        frame.stack.push(frame.locals[0]);
        break;
      case 'iload_1':
        frame.stack.push(frame.locals[1]);
        break;
      case 'iadd': {
        const value2 = frame.stack.pop();
        const value1 = frame.stack.pop();
        frame.stack.push(value1 + value2);
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
const Stack = require('./stack');
const { loadClassByPath } = require('./classLoader');

class JVM {
  constructor() {
    this.stack = new Stack();
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
    const classData = loadClassByPath(classFilePath, options);
    if (!classData) {
      return;
    }

    const mainMethod = this.findMainMethod(classData);
    if (!mainMethod) {
      console.error('main method not found');
      return;
    }

    this.executeMethod(mainMethod);
  }

  findMainMethod(classData) {
    const mainMethod = classData.classes[0].items.find(item => {
      return item.type === 'method' &&
             item.method.name === 'main' &&
             item.method.descriptor === '([Ljava/lang/String;)V';
    });
    return mainMethod ? mainMethod.method : null;
  }

  executeMethod(method) {
    const code = method.attributes.find(attr => attr.type === 'code').code;
    const instructions = code.codeItems;

    for (const instruction of instructions) {
      if (instruction.instruction) {
        this.executeInstruction(instruction.instruction);
      }
    }
  }

  executeInstruction(instruction) {
    const op = typeof instruction === 'string' ? instruction : instruction.op;
    const arg = instruction.arg;

    switch (op) {
      case 'getstatic': {
        const [_, className, [fieldName, descriptor]] = arg;
        const field = this.jre[className][fieldName];
        this.stack.push(field);
        break;
      }
      case 'ldc': {
        const value = arg.replace(/"/g, '');
        this.stack.push(value);
        break;
      }
      case 'invokevirtual': {
        const [_, className, [methodName, descriptor]] = arg;
        const value = this.stack.pop();
        const obj = this.stack.pop();
        if (obj[className] && obj[className][methodName]) {
          obj[className][methodName](value);
        }
        break;
      }
      case 'return':
        // For now, just stop execution
        break;
      default:
        // console.log(`Unknown instruction: ${op}`);
    }
  }
}

module.exports = JVM;
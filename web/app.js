// Browser-compatible versions of the JVM components

// Simple Stack implementation
class Stack {
  constructor() {
    this.items = [];
  }

  push(item) {
    this.items.push(item);
  }

  pop() {
    return this.items.pop();
  }

  peek() {
    return this.items[this.items.length - 1];
  }

  isEmpty() {
    return this.items.length === 0;
  }

  size() {
    return this.items.length;
  }

  clear() {
    this.items = [];
  }
}

// Simple class loader for browser
class BrowserClassLoader {
  static parseClassFile(arrayBuffer) {
    // This is a simplified parser - in a real implementation you'd use the jvm_parser
    // For now, we'll return mock data structure that matches what the JVM expects
    const view = new DataView(arrayBuffer);
    
    // Mock parsing - in real implementation this would parse the actual bytecode
    return {
      name: 'MockClass',
      methods: [{
        name: 'main',
        descriptor: '([Ljava/lang/String;)V',
        flags: ['public', 'static'],
        attributes: [{
          type: 'code',
          code: {
            localsSize: '1',
            codeItems: [
              ['iconst_1'],
              ['iconst_2'],
              ['iadd'],
              ['istore_0'],
              ['iload_0'],
              ['invokestatic', ['java/lang/System', ['exit', '(I)V']]],
              ['return']
            ],
            exceptionTable: []
          }
        }]
      }]
    };
  }
}

// Browser-compatible JVM implementation
class BrowserJVM {
  constructor() {
    this.callStack = new Stack();
    this.classes = {};
    this.executionSteps = [];
    this.currentStep = 0;
    this.output = [];
    
    this.jre = {
      'java/lang/System': {
        'out': {
          'java/io/PrintStream': {
            'println': (str) => {
              this.output.push(str);
              console.log(str);
            }
          }
        }
      }
    };
  }

  loadClass(classData) {
    if (classData && classData.name) {
      this.classes[classData.name] = classData;
    }
    return classData;
  }

  findMainMethod(classData) {
    return classData.methods.find(method =>
      method.name === 'main' &&
      method.descriptor === '([Ljava/lang/String;)V' &&
      method.flags.includes('public') &&
      method.flags.includes('static')
    );
  }

  prepareExecution(classData) {
    const mainMethod = this.findMainMethod(classData);
    if (!mainMethod) {
      throw new Error('main method not found');
    }

    const frame = new Frame(mainMethod);
    this.callStack.clear();
    this.callStack.push(frame);
    this.executionSteps = [];
    this.currentStep = 0;
    this.output = [];

    // Pre-calculate all execution steps
    this.calculateExecutionSteps();
    
    return {
      totalSteps: this.executionSteps.length,
      instructions: frame.instructions
    };
  }

  calculateExecutionSteps() {
    const tempJVM = new BrowserJVM();
    tempJVM.classes = this.classes;
    
    // Clone the current frame
    const originalFrame = this.callStack.peek();
    const tempFrame = new Frame(originalFrame.method);
    tempJVM.callStack.push(tempFrame);

    while (!tempJVM.callStack.isEmpty()) {
      const frame = tempJVM.callStack.peek();
      if (frame.pc >= frame.instructions.length) {
        tempJVM.callStack.pop();
        continue;
      }

      const instruction = frame.instructions[frame.pc];
      
      this.executionSteps.push({
        pc: frame.pc,
        instruction: instruction,
        stackBefore: frame.stack.items.slice(),
        localsBefore: frame.locals.slice(),
        step: this.executionSteps.length
      });

      try {
        tempJVM.executeInstruction(frame, instruction);
      } catch (error) {
        console.error('Error in step calculation:', error);
        break;
      }

      frame.pc++;
    }
  }

  step() {
    if (this.currentStep >= this.executionSteps.length) {
      return null;
    }

    const stepInfo = this.executionSteps[this.currentStep];
    const frame = this.callStack.peek();
    
    if (!frame) {
      return null;
    }

    // Update frame state to match the step
    frame.pc = stepInfo.pc;
    frame.stack.items = stepInfo.stackBefore.slice();
    frame.locals = stepInfo.localsBefore.slice();

    // Execute the instruction
    try {
      this.executeInstruction(frame, stepInfo.instruction);
    } catch (error) {
      console.error('Execution error:', error);
    }

    this.currentStep++;

    return {
      step: this.currentStep,
      totalSteps: this.executionSteps.length,
      pc: stepInfo.pc,
      instruction: stepInfo.instruction,
      stackAfter: frame.stack.items.slice(),
      localsAfter: frame.locals.slice(),
      output: this.output.slice(),
      completed: this.currentStep >= this.executionSteps.length
    };
  }

  executeInstruction(frame, instruction) {
    const [op, arg] = instruction;

    switch (op) {
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
      case 'ldc': {
        const value = arg.replace(/"/g, '');
        frame.stack.push(value);
        break;
      }
      case 'getstatic': {
        const [_, className, [fieldName]] = arg;
        const field = this.jre[className][fieldName];
        frame.stack.push(field);
        break;
      }
      case 'invokevirtual': {
        const [_, className, [methodName]] = arg;
        if (className === 'java/io/PrintStream' && methodName === 'println') {
          const arg = frame.stack.pop();
          frame.stack.pop(); // pop the PrintStream object
          this.jre['java/lang/System']['out']['java/io/PrintStream']['println'](arg);
        }
        break;
      }
      case 'return':
        // Method return - handled by stepping logic
        break;
      default:
        console.log(`Unknown instruction: ${op}`);
        break;
    }
  }

  reset() {
    this.currentStep = 0;
    this.output = [];
    
    if (!this.callStack.isEmpty()) {
      const frame = this.callStack.peek();
      frame.pc = 0;
      frame.stack.clear();
      frame.locals.fill(undefined);
    }
  }
}

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

// Main application
class JVMShowcase {
  constructor() {
    this.jvm = new BrowserJVM();
    this.currentClass = null;
    this.currentSource = null;
    this.sampleClasses = [];
    
    this.initializeElements();
    this.setupEventListeners();
    this.loadSampleClasses();
  }

  initializeElements() {
    this.elements = {
      classFileInput: document.getElementById('classFileInput'),
      sampleSelect: document.getElementById('sampleSelect'),
      loadClassBtn: document.getElementById('loadClassBtn'),
      stepBtn: document.getElementById('stepBtn'),
      runBtn: document.getElementById('runBtn'),
      resetBtn: document.getElementById('resetBtn'),
      executionControls: document.querySelector('.execution-controls'),
      executionStatus: document.getElementById('executionStatus'),
      stepCounter: document.getElementById('stepCounter'),
      bytecodeDisplay: document.getElementById('bytecodeDisplay'),
      sourceDisplay: document.getElementById('sourceDisplay'),
      stackDisplay: document.getElementById('stackDisplay'),
      localsDisplay: document.getElementById('localsDisplay'),
      outputDisplay: document.getElementById('outputDisplay'),
      tabBtns: document.querySelectorAll('.tab-btn'),
      tabPanes: document.querySelectorAll('.tab-pane')
    };
  }

  setupEventListeners() {
    this.elements.classFileInput.addEventListener('change', (e) => {
      if (e.target.files[0]) {
        this.elements.sampleSelect.value = '';
        this.elements.loadClassBtn.disabled = false;
      }
    });

    this.elements.sampleSelect.addEventListener('change', (e) => {
      if (e.target.value) {
        this.elements.classFileInput.value = '';
        this.elements.loadClassBtn.disabled = false;
      }
    });

    this.elements.loadClassBtn.addEventListener('click', () => {
      this.loadClass();
    });

    this.elements.stepBtn.addEventListener('click', () => {
      this.executeStep();
    });

    this.elements.runBtn.addEventListener('click', () => {
      this.runAll();
    });

    this.elements.resetBtn.addEventListener('click', () => {
      this.reset();
    });

    // Tab switching
    this.elements.tabBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tabName = e.target.dataset.tab;
        this.switchTab(tabName);
      });
    });
  }

  async loadSampleClasses() {
    try {
      // Load sample class list
      this.sampleClasses = [
        { name: 'VerySimple', file: 'VerySimple.class', hasSource: true },
        { name: 'Calculator', file: 'Calculator.class', hasSource: true },
        { name: 'Hello', file: 'Hello.class', hasSource: true },
        { name: 'RuntimeArithmetic', file: 'RuntimeArithmetic.class', hasSource: true }
      ];

      this.populateSampleSelect();
    } catch (error) {
      console.error('Failed to load sample classes:', error);
    }
  }

  populateSampleSelect() {
    const select = this.elements.sampleSelect;
    
    this.sampleClasses.forEach(cls => {
      const option = document.createElement('option');
      option.value = cls.name;
      option.textContent = `${cls.name}${cls.hasSource ? ' (with source)' : ''}`;
      select.appendChild(option);
    });
  }

  async loadClass() {
    try {
      let classData;
      let sourceName = null;

      if (this.elements.classFileInput.files[0]) {
        // Load uploaded file
        const file = this.elements.classFileInput.files[0];
        const arrayBuffer = await file.arrayBuffer();
        classData = BrowserClassLoader.parseClassFile(arrayBuffer);
        classData.name = file.name.replace('.class', '');
      } else if (this.elements.sampleSelect.value) {
        // Load sample class
        const className = this.elements.sampleSelect.value;
        const classInfo = this.sampleClasses.find(c => c.name === className);
        
        if (classInfo) {
          classData = this.createSampleClassData(className);
          if (classInfo.hasSource) {
            sourceName = className;
          }
        }
      }

      if (classData) {
        this.currentClass = classData;
        this.jvm.loadClass(classData);
        
        const execInfo = this.jvm.prepareExecution(classData);
        this.displayBytecode(execInfo.instructions);
        
        if (sourceName) {
          await this.loadAndDisplaySource(sourceName);
        } else {
          this.displayNoSource();
        }

        this.elements.executionControls.style.display = 'block';
        this.elements.executionStatus.textContent = 'Ready to execute';
        this.elements.stepCounter.textContent = `Step: 0 / ${execInfo.totalSteps}`;
        
        this.updateDisplay();
      }
    } catch (error) {
      console.error('Failed to load class:', error);
      alert('Failed to load class: ' + error.message);
    }
  }

  createSampleClassData(className) {
    // Create mock class data for samples
    const samplePrograms = {
      'VerySimple': {
        instructions: [
          ['iconst_3'],
          ['iconst_2'],
          ['isub'],
          ['istore_0'],
          ['getstatic', ['java/lang/System', ['out']]],
          ['iload_0'],
          ['invokevirtual', ['java/io/PrintStream', ['println', '(I)V']]],
          ['return']
        ]
      },
      'Hello': {
        instructions: [
          ['getstatic', ['java/lang/System', ['out']]],
          ['ldc', '"Hello, World!"'],
          ['invokevirtual', ['java/io/PrintStream', ['println', '(Ljava/lang/String;)V']]],
          ['return']
        ]
      },
      'Calculator': {
        instructions: [
          ['iconst_2'],
          ['iconst_2'],
          ['iadd'],
          ['istore_0'],
          ['getstatic', ['java/lang/System', ['out']]],
          ['iload_0'],
          ['invokevirtual', ['java/io/PrintStream', ['println', '(I)V']]],
          ['return']
        ]
      },
      'RuntimeArithmetic': {
        instructions: [
          ['iconst_5'],
          ['iconst_3'],
          ['iadd'],
          ['istore_0'],
          ['iconst_4'],
          ['iconst_2'],
          ['isub'],
          ['istore_1'],
          ['iload_0'],
          ['iload_1'],
          ['imul'],
          ['istore_2'],
          ['getstatic', ['java/lang/System', ['out']]],
          ['iload_2'],
          ['invokevirtual', ['java/io/PrintStream', ['println', '(I)V']]],
          ['return']
        ]
      }
    };

    const program = samplePrograms[className] || samplePrograms['VerySimple'];
    
    return {
      name: className,
      methods: [{
        name: 'main',
        descriptor: '([Ljava/lang/String;)V',
        flags: ['public', 'static'],
        attributes: [{
          type: 'code',
          code: {
            localsSize: '4',
            codeItems: program.instructions,
            exceptionTable: []
          }
        }]
      }]
    };
  }

  async loadAndDisplaySource(className) {
    try {
      // In a real implementation, this would fetch the actual source
      const sampleSources = {
        'VerySimple': `public class VerySimple {
    public static void main(String[] args) {
        int result = 3 - 2;
        System.out.println(result);
    }
}`,
        'Hello': `public class Hello {
    public static void main(String[] args) {
        System.out.println("Hello, World!");
    }
}`,
        'Calculator': `public class Calculator {
    public static void main(String[] args) {
        int result = 2 + 2;
        System.out.println(result);
    }
}`,
        'RuntimeArithmetic': `public class RuntimeArithmetic {
    public static void main(String[] args) {
        int a = 5 + 3;
        int b = 4 - 2;
        int result = a * b;
        System.out.println(result);
    }
}`
      };

      const source = sampleSources[className] || 'Source code not available';
      this.displaySource(source);
    } catch (error) {
      console.error('Failed to load source:', error);
      this.displayNoSource();
    }
  }

  displayBytecode(instructions) {
    const container = this.elements.bytecodeDisplay;
    container.innerHTML = '';

    instructions.forEach((instruction, index) => {
      const line = document.createElement('div');
      line.className = 'instruction-line';
      line.dataset.pc = index;

      const pc = document.createElement('span');
      pc.className = 'pc-number';
      pc.textContent = index.toString().padStart(3, ' ');

      const op = document.createElement('span');
      op.className = 'instruction-op';
      op.textContent = instruction[0];

      const arg = document.createElement('span');
      arg.className = 'instruction-arg';
      arg.textContent = instruction[1] ? JSON.stringify(instruction[1]) : '';

      line.appendChild(pc);
      line.appendChild(op);
      line.appendChild(arg);
      container.appendChild(line);
    });
  }

  displaySource(sourceCode) {
    const container = this.elements.sourceDisplay;
    container.innerHTML = '';

    const lines = sourceCode.split('\n');
    lines.forEach((line, index) => {
      const lineEl = document.createElement('div');
      lineEl.className = 'source-line';
      lineEl.dataset.line = index + 1;

      const lineNumber = document.createElement('span');
      lineNumber.className = 'line-number';
      lineNumber.textContent = (index + 1).toString().padStart(3, ' ');

      const lineContent = document.createElement('span');
      lineContent.textContent = line;

      lineEl.appendChild(lineNumber);
      lineEl.appendChild(lineContent);
      container.appendChild(lineEl);
    });
  }

  displayNoSource() {
    this.elements.sourceDisplay.innerHTML = '<div class="placeholder">Source code not available</div>';
  }

  executeStep() {
    const result = this.jvm.step();
    
    if (result) {
      this.elements.stepCounter.textContent = `Step: ${result.step} / ${result.totalSteps}`;
      
      if (result.completed) {
        this.elements.executionStatus.textContent = 'Execution completed';
        this.elements.stepBtn.disabled = true;
      } else {
        this.elements.executionStatus.textContent = `Executing: ${result.instruction[0]}`;
      }
      
      this.updateDisplay(result);
      this.highlightCurrentInstruction(result.pc);
    }
  }

  runAll() {
    let result;
    do {
      result = this.jvm.step();
      if (result) {
        this.updateDisplay(result);
      }
    } while (result && !result.completed);

    if (result) {
      this.elements.stepCounter.textContent = `Step: ${result.step} / ${result.totalSteps}`;
      this.elements.executionStatus.textContent = 'Execution completed';
      this.elements.stepBtn.disabled = true;
      this.highlightCurrentInstruction(result.pc);
    }
  }

  reset() {
    this.jvm.reset();
    this.elements.executionStatus.textContent = 'Ready to execute';
    this.elements.stepCounter.textContent = 'Step: 0';
    this.elements.stepBtn.disabled = false;
    
    this.updateDisplay();
    this.clearHighlights();
  }

  updateDisplay(result = null) {
    this.updateStackDisplay(result ? result.stackAfter : []);
    this.updateLocalsDisplay(result ? result.localsAfter : []);
    this.updateOutputDisplay(result ? result.output : []);
  }

  updateStackDisplay(stack) {
    const container = this.elements.stackDisplay;
    
    if (stack.length === 0) {
      container.innerHTML = '<div class="stack-empty">Stack is empty</div>';
      return;
    }

    container.innerHTML = '';
    stack.forEach((item, index) => {
      const stackItem = document.createElement('div');
      stackItem.className = 'stack-item';
      stackItem.textContent = `${index}: ${this.formatValue(item)}`;
      container.appendChild(stackItem);
    });
  }

  updateLocalsDisplay(locals) {
    const container = this.elements.localsDisplay;
    
    if (locals.every(local => local === undefined)) {
      container.innerHTML = '<div class="locals-empty">No local variables</div>';
      return;
    }

    container.innerHTML = '';
    locals.forEach((local, index) => {
      const localVar = document.createElement('div');
      localVar.className = 'local-var';

      const varIndex = document.createElement('span');
      varIndex.className = 'var-index';
      varIndex.textContent = `[${index}]`;

      const varValue = document.createElement('span');
      varValue.className = `var-value${local === undefined ? ' undefined' : ''}`;
      varValue.textContent = this.formatValue(local);

      localVar.appendChild(varIndex);
      localVar.appendChild(varValue);
      container.appendChild(localVar);
    });
  }

  updateOutputDisplay(output) {
    const container = this.elements.outputDisplay;
    
    if (output.length === 0) {
      container.innerHTML = '<div class="output-empty">No output yet</div>';
      return;
    }

    container.innerHTML = '';
    output.forEach(line => {
      const outputLine = document.createElement('div');
      outputLine.className = 'output-line';
      outputLine.textContent = line;
      container.appendChild(outputLine);
    });
  }

  formatValue(value) {
    if (value === undefined) {
      return 'undefined';
    }
    if (value === null) {
      return 'null';
    }
    if (typeof value === 'string') {
      return `"${value}"`;
    }
    return String(value);
  }

  highlightCurrentInstruction(pc) {
    this.clearHighlights();
    
    const instructionLine = document.querySelector(`[data-pc="${pc}"]`);
    if (instructionLine) {
      instructionLine.classList.add('current');
    }
  }

  clearHighlights() {
    document.querySelectorAll('.instruction-line').forEach(line => {
      line.classList.remove('current', 'executed');
    });
  }

  switchTab(tabName) {
    // Update tab buttons
    this.elements.tabBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    // Update tab panes
    this.elements.tabPanes.forEach(pane => {
      pane.classList.toggle('active', pane.id === `${tabName}-tab`);
    });
  }
}

// Initialize the application
document.addEventListener('DOMContentLoaded', () => {
  new JVMShowcase();
});
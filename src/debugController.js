const { JVM } = require('./jvm');
const Frame = require('./frame');

class DebugController {
  constructor(options = {}) {
    this.jvm = new JVM(options);
    this.executionState = 'stopped'; // stopped, running, paused
  }

  async start(classFilePath, options = {}) {
    try {
      // Start the JVM but in a paused state
      this.jvm.debugManager.enable();
      this.jvm.debugManager.pause();
      await this.jvm.run(classFilePath, options);
      this.executionState = 'paused';

      return {
        status: 'started',
        state: this.getCurrentState()
      };
    } catch (e) {
      this.executionState = 'stopped';
      throw new Error(`Error loading class: ${e.message}`);
    }
  }

  async continue() {
    if (this.executionState !== 'paused') {
      throw new Error('Cannot continue: execution is not paused');
    }
    this.executionState = 'running';
    const result = await this.jvm.execute();
    if (result.paused) {
      this.executionState = 'paused';
    } else {
      this.executionState = 'stopped';
    }
    return { status: this.executionState, state: this.getCurrentState() };
  }

  async stepInto() {
    return this.jvmStep();
  }

  async stepOver() {
    return this.jvmStep();
  }

  async stepOut() {
    return this.jvmStep();
  }

  async stepInstruction() {
    return this.jvmStep();
  }

  async finish() {
    return this.jvmStep();
  }

  async jvmStep() {
    if (this.executionState !== 'paused') {
      throw new Error('Cannot step: execution is not paused');
    }
    const result = await this.jvm.executeTick();
    if (result.completed) {
      this.executionState = 'stopped';
    }
    return { status: this.executionState, state: this.getCurrentState() };
  }

  async threadStep() {
    if (this.executionState !== 'paused') {
      throw new Error('Cannot step: execution is not paused');
    }

    const targetThreadId = this.jvm.debugManager.selectedThreadId;

    // Step one tick first
    let result = await this.jvm.executeTick();
    if (result.completed) {
        this.executionState = 'stopped';
        return { status: this.executionState, state: this.getCurrentState() };
    }

    // Keep ticking until the selected thread is the current one again
    while (this.jvm.currentThreadIndex !== targetThreadId && !result.completed) {
        result = await this.jvm.executeTick();
        if (result.completed) {
            break;
        }
    }
    
    if (result.completed) {
        this.executionState = 'stopped';
    }

    return { status: this.executionState, state: this.getCurrentState() };
  }

  selectThread(threadId) {
    this.jvm.debugManager.selectThread(threadId);
    return { status: 'thread_selected', threadId: threadId };
  }

  getThreads() {
    return this.jvm.threads.map(t => ({ id: t.id, status: t.status }));
  }

  setBreakpoint(pc) {
    this.jvm.debugManager.addBreakpoint(pc);
    return { status: 'breakpoint_set', pc: pc };
  }

  removeBreakpoint(pc) {
    this.jvm.debugManager.removeBreakpoint(pc);
    return { status: 'breakpoint_removed', pc: pc };
  }

  clearBreakpoints() {
    this.jvm.debugManager.clearBreakpoints();
    return { status: 'breakpoints_cleared' };
  }

  getCurrentState() {
    const thread = this.jvm.threads[this.jvm.currentThreadIndex];
    if (!thread) {
      return { executionState: this.executionState, pc: null, stack: [], locals: [], callStackDepth: 0, method: null, breakpoints: [] };
    }

    let frame;
    try {
      frame = thread.callStack.peek();
    } catch (error) {
      // Stack is empty - execution completed
      frame = null;
    }
    
    if (!frame) {
      return { executionState: this.executionState, pc: null, stack: [], locals: [], callStackDepth: 0, method: null, breakpoints: [] };
    }

    const instructionItem = frame.instructions[frame.pc];
    const label = instructionItem ? instructionItem.labelDef : null;
    const currentPc = label ? parseInt(label.substring(1, label.length - 1)) : -1;
    
    return {
      executionState: this.executionState,
      currentThreadId: this.jvm.currentThreadIndex,
      pc: currentPc,
      stack: frame.stack.items,
      locals: frame.locals,
      callStackDepth: thread.callStack.size(),
      method: { name: frame.method.name, descriptor: frame.method.descriptor },
      breakpoints: Array.from(this.jvm.debugManager.breakpoints)
    };
  }

  reset() {
    this.jvm = new JVM();
    this.executionState = 'stopped';
    return { status: 'reset' };
  }

  getBreakpoints() {
    return Array.from(this.jvm.debugManager.breakpoints);
  }

  isPaused() {
    return this.executionState === 'paused';
  }

  isCompleted() {
    return this.executionState === 'stopped';
  }

  serialize() {
    return {
      jvmState: this.jvm.serialize(),
      executionState: this.executionState,
    };
  }

  deserialize(state) {
    this.jvm.deserialize(state.jvmState);
    this.executionState = state.executionState || 'stopped';
    return { status: 'restored' };
  }

  getBacktrace(threadId) {
    return this.jvm.getBacktrace(threadId);
  }

  inspectStack(threadId) {
    return this.jvm.inspectStack(threadId);
  }

  inspectLocals(threadId) {
    return this.jvm.inspectLocals(threadId);
  }

  inspectLocalVariable(index, threadId) {
    return this.jvm.inspectLocalVariable(index, threadId);
  }

  inspectStackValue(index, threadId) {
    return this.jvm.inspectStackValue(index, threadId);
  }

  getAvailableVariableNames(threadId) {
    return this.jvm.getAvailableVariableNames(threadId);
  }

  inspectObject(objRef) {
    return this.jvm.inspectObject(objRef);
  }

  getDisassemblyView() {
    return this.jvm.getDisassemblyView();
  }
}

module.exports = DebugController;
const { JVM } = require('../core/jvm');
const Frame = require('../core/frame');

class DebugController {
  constructor(options = {}) {
    this.options = {
      rewindHistorySize: 0,
      ...options,
    };
    this.jvm = new JVM(this.options);
    this.executionState = 'stopped'; // stopped, running, paused
    this.history = [];
    // Store last known state for display purposes when execution completes
    this.lastKnownState = {
      pc: null,
      method: null,
      stack: [],
      locals: [],
      callStackDepth: 0
    };
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

  /**
   * Resume until a breakpoint whose condition holds, or until the program
   * ends.  A conditional breakpoint stops the world, evaluates its expression
   * against the live heap, and resumes when the answer is false — the same
   * stop-and-evaluate shape browsers use, so a condition in a hot loop is
   * correct but not cheap.
   */
  async continue() {
    for (;;) {
      const result = await this._continueOnce();
      if (this.executionState !== 'paused') return result;
      const condition = this._conditionForCurrentStop();
      if (!condition) return result;
      const verdict = await this._evaluateCondition(condition);
      if (verdict.stop) {
        return { ...result, condition: condition.condition, ...verdict };
      }
    }
  }

  async _continueOnce() {
    if (this.executionState !== 'paused') {
      throw new Error('Cannot continue: execution is not paused');
    }
    this.executionState = 'running';
    this.jvm.debugManager.setRunMode('continuing');
    const result = await this.jvm.execute();
    if (result.paused) {
      this.executionState = 'paused';
    } else {
      this.executionState = 'stopped';
    }
    return { status: this.executionState, state: this.getCurrentState() };
  }

  pause() {
    if (this.executionState !== 'running') {
      throw new Error('Cannot pause: execution is not running');
    }
    this.jvm.debugManager.pause();
    this.executionState = 'paused';
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

    if (this.options.rewindHistorySize > 0) {
      this.history.push(this.serialize());
      if (this.history.length > this.options.rewindHistorySize) {
        this.history.shift();
      }
    }

    this.jvm.debugManager.setRunMode('stepping');
    const result = await this.jvm.executeTick();
    this.jvm.debugManager.setRunMode('paused');
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
    this.jvm.addBreakpoint(pc);
    return { status: 'breakpoint_set', pc: pc };
  }

  /**
   * Set a breakpoint from a human location: `Class.method`,
   * `Class.method(desc)+offset`, `File.java:12`, `:12`, or a bare offset.
   * A resolved class/method binds the breakpoint to that frame, so the offset
   * no longer fires in every method that happens to reach it.
   */
  setBreakpointAt(spec) {
    const { resolveBreakpoint } = require('./breakpointResolver');
    // `<where> if <expression>` attaches a condition to the location.
    const parsed = /^(.*?)\s+if\s+(.+)$/.exec(String(spec).trim());
    const where = parsed ? parsed[1].trim() : String(spec).trim();
    const condition = parsed ? parsed[2].trim() : null;
    const state = this.executionState === 'stopped' ? null : this.getCurrentState();
    let resolved;
    try {
      resolved = resolveBreakpoint(this.jvm, where, state && state.className);
    } catch (error) {
      // Class loading is lazy, so the interesting class usually does not exist
      // yet when the breakpoint is set.  Keep the request and arm it the moment
      // the class arrives, rather than making the user race the loader.
      if (error.classNotLoaded) return this._deferBreakpoint(spec, error);
      throw error;
    }
    // `Class.method*` resolves to every overload, so the result may be a list.
    const targets = Array.isArray(resolved) ? resolved : [resolved];
    for (const target of targets) {
      if (target.className) {
        this.jvm.addLocatedBreakpoint(target.pc, target);
      } else {
        this.jvm.addBreakpoint(target.pc);
      }
      this._rememberCondition(target, condition);
    }
    if (Array.isArray(resolved)) {
      return { status: 'breakpoint_set', targets, condition };
    }
    return { status: 'breakpoint_set', ...resolved, condition };
  }

  _deferBreakpoint(spec, error) {
    if (!this.pendingBreakpoints) this.pendingBreakpoints = [];
    const parsed = /^(.*?)\s+if\s+(.+)$/.exec(String(spec).trim());
    if (!this.pendingBreakpoints.some((entry) => entry.spec === spec)) {
      this.pendingBreakpoints.push({
        spec,
        where: parsed ? parsed[1].trim() : String(spec).trim(),
        condition: parsed ? parsed[2].trim() : null,
        className: error.className,
      });
    }
    this._watchClassLoads();
    return {
      status: 'breakpoint_pending',
      spec,
      where: parsed ? parsed[1].trim() : String(spec).trim(),
      condition: parsed ? parsed[2].trim() : null,
      className: error.className,
      reason: error.message,
    };
  }

  _watchClassLoads() {
    if (this._classLoadUnsubscribe) return;
    this._classLoadUnsubscribe = this.jvm.onClassLoaded(() => {
      this.resolvePendingBreakpoints();
    });
  }

  /**
   * Try to arm every deferred breakpoint.  Called automatically whenever a
   * class is loaded; safe to call by hand.
   */
  resolvePendingBreakpoints() {
    if (!this.pendingBreakpoints || !this.pendingBreakpoints.length) return [];
    const { resolveBreakpoint } = require('./breakpointResolver');
    const armed = [];
    const stillPending = [];
    for (const entry of this.pendingBreakpoints) {
      let resolved;
      try {
        resolved = resolveBreakpoint(this.jvm, entry.where, null);
      } catch (error) {
        // Still not loaded: keep waiting.  Anything else is a real mistake in
        // the spec and should stop being retried on every future class load.
        if (error.classNotLoaded) stillPending.push(entry);
        else armed.push({ spec: entry.spec, error: error.message });
        continue;
      }
      for (const target of Array.isArray(resolved) ? resolved : [resolved]) {
        if (target.className) this.jvm.addLocatedBreakpoint(target.pc, target);
        else this.jvm.addBreakpoint(target.pc);
        this._rememberCondition(target, entry.condition);
        armed.push({ spec: entry.spec, ...target });
      }
    }
    this.pendingBreakpoints = stillPending;
    return armed;
  }

  getPendingBreakpoints() {
    return (this.pendingBreakpoints || []).map((entry) => entry.spec);
  }

  _conditionKey(pc, target) {
    return target && target.className
      ? `${pc}|${target.className}.${target.methodName}${target.descriptor}`
      : `${pc}|*`;
  }

  _rememberCondition(target, condition) {
    if (!condition) return;
    if (!this.breakpointConditions) this.breakpointConditions = new Map();
    this.breakpointConditions.set(this._conditionKey(target.pc, target), {
      condition,
      pc: target.pc,
      className: target.className || null,
      methodName: target.methodName || null,
      descriptor: target.descriptor || null,
    });
  }

  _conditionForCurrentStop() {
    if (!this.breakpointConditions || !this.breakpointConditions.size) return null;
    const state = this.getCurrentState();
    if (!state || state.pc === null || state.pc === undefined) return null;
    const exact = state.method && state.className
      ? this.breakpointConditions.get(
        `${state.pc}|${state.className}.${state.method.name}${state.method.descriptor}`)
      : null;
    return exact || this.breakpointConditions.get(`${state.pc}|*`) || null;
  }

  async _evaluateCondition(entry) {
    const { prepareEvaluation } = require('./evaluator');
    try {
      // Compile the condition once and reuse it.  A hot location can be hit
      // hundreds of thousands of times, and compiling a class per hit makes
      // the feature unusable rather than merely slow.
      if (!this.preparedConditions) this.preparedConditions = new Map();
      let prepared = this.preparedConditions.get(entry.condition);
      if (!prepared) {
        prepared = await prepareEvaluation(this.jvm, entry.condition);
        this.preparedConditions.set(entry.condition, prepared);
      }
      const result = await prepared.run();
      const value = result && result.value;
      return { stop: value === true || value === 1, value };
    } catch (error) {
      // A condition that cannot be evaluated must not silently swallow the
      // breakpoint: stop and report, rather than running past it.
      return { stop: true, conditionError: error.message };
    }
  }

  getBreakpointConditions() {
    if (!this.breakpointConditions) return [];
    return [...this.breakpointConditions.values()].map((entry) => ({
      where: entry.className
        ? `${entry.className}.${entry.methodName}${entry.descriptor}+${entry.pc}`
        : `offset ${entry.pc}`,
      condition: entry.condition,
    }));
  }

  /**
   * The classpath the JVM resolves against.  jvm.loadClassByName walks this
   * array on every miss, so edits take effect for classes not yet loaded;
   * classes already resident stay cached until reset().
   */
  getClasspath() {
    return Array.isArray(this.jvm.classpath) ? [...this.jvm.classpath] : [];
  }

  setClasspath(entries) {
    const list = (Array.isArray(entries) ? entries : [entries])
      .map((entry) => String(entry).trim())
      .filter(Boolean);
    this.jvm.classpath = list;
    this.options.classpath = list;
    return this.getClasspath();
  }

  addClasspath(entry) {
    const value = String(entry || '').trim();
    if (!value) throw new Error('Expected a classpath entry');
    const list = this.getClasspath();
    if (!list.includes(value)) list.push(value);
    return this.setClasspath(list);
  }

  removeClasspath(entryOrIndex) {
    const list = this.getClasspath();
    const asIndex = Number(entryOrIndex);
    if (Number.isInteger(asIndex) && String(entryOrIndex).trim() !== '' &&
        asIndex >= 0 && asIndex < list.length) {
      list.splice(asIndex, 1);
      return this.setClasspath(list);
    }
    const value = String(entryOrIndex || '').trim();
    const at = list.indexOf(value);
    if (at < 0) throw new Error(`Not on the classpath: ${value}`);
    list.splice(at, 1);
    return this.setClasspath(list);
  }

  /** Completion candidates for a partially typed class or method name. */
  completeLocation(partial) {
    const { complete } = require('./breakpointResolver');
    return complete(this.jvm, partial);
  }

  removeBreakpoint(pc) {
    this.jvm.removeBreakpoint(pc);
    return { status: 'breakpoint_removed', pc: pc };
  }

  clearBreakpoints() {
    this.jvm.debugManager.clearBreakpoints();
    return { status: 'breakpoints_cleared' };
  }

  getCurrentState() {
    const thread = this.jvm.threads[this.jvm.currentThreadIndex];
    if (!thread) {
      return { 
        executionState: this.executionState, 
        pc: this.lastKnownState.pc, 
        stack: [], 
        locals: [], 
        callStackDepth: 0, 
        method: this.lastKnownState.method, 
        breakpoints: [] 
      };
    }

    let frame;
    try {
      frame = thread.callStack.peek();
    } catch (error) {
      // Stack is empty - execution completed
      frame = null;
    }
    
    if (!frame) {
      // Return last known state when execution is complete but with current execution state
      return { 
        executionState: this.executionState, 
        pc: this.lastKnownState.pc, 
        stack: [], 
        locals: [], 
        callStackDepth: 0, 
        method: this.lastKnownState.method, 
        breakpoints: Array.from(this.jvm.debugManager.breakpoints) 
      };
    }

    const currentPc = this.jvm._resolveFramePc(frame);
    
    // Update last known state for future use
    this.lastKnownState = {
      pc: currentPc,
      method: { name: frame.method.name, descriptor: frame.method.descriptor },
      stack: frame.stack.items,
      locals: frame.locals,
      callStackDepth: thread.callStack.size()
    };
    
    // Best-effort source mapping from the method's LineNumberTable/SourceFile
    // attributes; absent tables simply leave these null.
    let sourceLine = null;
    let sourceFile = null;
    try {
      const mapping = this.jvm.getSourceLineMapping(currentPc, frame.method);
      if (mapping && typeof mapping.line === 'number') sourceLine = mapping.line;
      sourceFile = this.jvm.getSourceFileName(frame.className);
    } catch (error) {
      // Source info is advisory; never let it break state reporting.
    }

    return {
      executionState: this.executionState,
      currentThreadId: this.jvm.currentThreadIndex,
      pc: currentPc,
      stack: frame.stack.items,
      locals: frame.locals,
      callStackDepth: thread.callStack.size(),
      method: { name: frame.method.name, descriptor: frame.method.descriptor },
      className: frame.className,
      sourceLine,
      sourceFile,
      breakpoints: Array.from(this.jvm.debugManager.breakpoints)
    };
  }

  reset() {
    this.jvm = new JVM(this.options);
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

  async deserialize(state) {
    await this.jvm.deserialize(state.jvmState);
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

  /**
   * Compile a Java snippet and run it against the live heap.
   *
   * Only available while the debugger is enabled: the snippet is ordinary
   * guest code and can mutate the program under inspection.
   *
   * @param {string} source - a Java expression or block of statements
   * @param {object} options - { stepBudget, sourceLevel }
   * @returns {Promise<object>} the evaluated value and generated class names
   */
  async evaluate(source, options = {}) {
    const { evaluateInLiveJvm } = require('./evaluator');
    return evaluateInLiveJvm(this.jvm, source, options);
  }

  getDisassemblyView() {
    try {
      return this.jvm.getDisassemblyView();
    } catch (error) {
      /* HARDENED: Handle case where no class is loaded */
      if (error.code === 'NO_THREAD') {
        return {
          formattedDisassembly: "",
          lineToPcMap: {},
          classFile: null,
          currentPc: -1,
        };
      }
      throw error;
    }
  }

  async rewind(steps = 1) {
    if (steps > this.history.length) {
      throw new Error('Cannot rewind: not enough history');
    }

    let stateToRestore = null;
    for (let i = 0; i < steps; i++) {
      stateToRestore = this.history.pop();
    }

    if (stateToRestore) {
      await this.deserialize(stateToRestore);
    }

    return { status: 'rewound', state: this.getCurrentState() };
  }
}

module.exports = DebugController;

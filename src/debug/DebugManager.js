class DebugManager {
  constructor() {
    this.debugMode = false;
    this.steppingMode = 'jvm-step'; // 'jvm-step' or 'thread-step'
    this.runMode = 'paused'; // 'paused', 'stepping', or 'continuing'
    this.selectedThreadId = 0;
    this.isPaused = true;
    this.breakpoints = new Set();
    this.breakpointLocations = new Map(); // pc -> Set<className>
    this.jitDeoptedClasses = new Set();
  }

  enable() {
    this.debugMode = true;
  }

  disable() {
    this.debugMode = false;
  }

  setSteppingMode(mode) {
    this.steppingMode = mode;
  }

  selectThread(threadId) {
    this.selectedThreadId = threadId;
  }

  pause() {
    this.isPaused = true;
    this.runMode = 'paused';
  }

  resume() {
    this.isPaused = false;
    this.runMode = 'continuing';
  }

  setRunMode(mode) {
    this.runMode = mode;
  }

  addBreakpoint(pc, location = null) {
    this.breakpoints.add(pc);
    if (location && location.className) {
      const classNames = this.breakpointLocations.get(pc) || new Set();
      classNames.add(location.className);
      this.breakpointLocations.set(pc, classNames);
      this.jitDeoptedClasses.add(location.className);
    }
  }

  removeBreakpoint(pc, location = null) {
    this.breakpoints.delete(pc);
    if (location && location.className) {
      const classNames = this.breakpointLocations.get(pc);
      if (classNames) {
        classNames.delete(location.className);
        if (classNames.size === 0) {
          this.breakpointLocations.delete(pc);
        }
      }
    } else {
      this.breakpointLocations.delete(pc);
    }
    this.rebuildJitDeoptedClasses();
  }

  clearBreakpoints() {
    this.breakpoints.clear();
    this.breakpointLocations.clear();
    this.jitDeoptedClasses.clear();
  }

  rebuildJitDeoptedClasses() {
    this.jitDeoptedClasses.clear();
    for (const classNames of this.breakpointLocations.values()) {
      for (const className of classNames) {
        this.jitDeoptedClasses.add(className);
      }
    }
  }

  isClassJitDeopted(className) {
    return Boolean(className && this.jitDeoptedClasses.has(className));
  }

  hasLocatedBreakpoints() {
    return this.breakpointLocations.size > 0;
  }

  serialize() {
    return {
      debugMode: this.debugMode,
      steppingMode: this.steppingMode,
      runMode: this.runMode,
      selectedThreadId: this.selectedThreadId,
      isPaused: this.isPaused,
      breakpoints: Array.from(this.breakpoints),
      breakpointLocations: Array.from(this.breakpointLocations.entries()).map(
        ([pc, classNames]) => [pc, Array.from(classNames)],
      ),
    };
  }

  deserialize(state) {
    /* HARDENED: Replaced quiet failure with an explicit error */
    if (!state) {
      throw new Error('DebugManager.deserialize requires a state object');
    }
    this.debugMode = state.debugMode;
    this.steppingMode = state.steppingMode;
    this.runMode = state.runMode || (state.isPaused ? 'paused' : 'continuing');
    this.selectedThreadId = state.selectedThreadId;
    this.isPaused = state.isPaused;
    this.breakpoints = new Set(state.breakpoints);
    this.breakpointLocations = new Map(
      (state.breakpointLocations || []).map(([pc, classNames]) => [pc, new Set(classNames)]),
    );
    this.rebuildJitDeoptedClasses();
  }
}

module.exports = DebugManager;

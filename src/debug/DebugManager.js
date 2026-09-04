class DebugManager {
  constructor() {
    this.debugMode = false;
    this.steppingMode = 'jvm-step'; // 'jvm-step' or 'thread-step'
    this.runMode = 'paused'; // 'paused', 'stepping', or 'continuing'
    this.selectedThreadId = 0;
    this.isPaused = true;
    this.breakpoints = new Set();
    this.breakpointLocations = new Map(); // pc -> Set<className>
    // pc -> Set<"Class" | "Class.method(descriptor)">.  A pc listed here fires
    // only inside a matching frame.  Breakpoints registered without a strict
    // location keep the historical behaviour of firing at that bytecode offset
    // in any method, so existing callers are unaffected.
    this.strictBreakpointLocations = new Map();
    this.jitDeoptedClasses = new Set();
    // `jitDeoptedClasses.size`, mirrored as a plain field. Generated call
    // entries read it once per call to skip the set lookup in the common case
    // where the debugger has deoptimized nothing; a runtime that does not
    // maintain the field simply leaves the comparison false and performs the
    // original membership test.
    this.jitDeoptedClassCount = 0;
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

  static locationKey(location) {
    if (!location || !location.className) return null;
    if (!location.methodName) return location.className;
    return `${location.className}.${location.methodName}${location.descriptor || ''}`;
  }

  /**
   * Register a breakpoint that fires only in the given class (and method, when
   * one is supplied), rather than at that bytecode offset everywhere.
   */
  addStrictBreakpoint(pc, location) {
    const key = DebugManager.locationKey(location);
    if (!key) {
      throw new Error('A strict breakpoint requires at least a className');
    }
    this.addBreakpoint(pc, location);
    const keys = this.strictBreakpointLocations.get(pc) || new Set();
    keys.add(key);
    this.strictBreakpointLocations.set(pc, keys);
    return { pc, location: key };
  }

  /**
   * Decide whether execution should stop at `pc` inside `location`.
   * Unlocated breakpoints match anywhere; strict ones must match the frame.
   */
  shouldBreakAt(pc, location = null) {
    if (!this.breakpoints.has(pc)) return false;
    const keys = this.strictBreakpointLocations.get(pc);
    if (!keys || keys.size === 0) return true;
    if (!location || !location.className) return false;
    if (keys.has(location.className)) return true;
    return keys.has(DebugManager.locationKey(location));
  }

  addBreakpoint(pc, location = null) {
    this.breakpoints.add(pc);
    if (location && location.className) {
      const classNames = this.breakpointLocations.get(pc) || new Set();
      classNames.add(location.className);
      this.breakpointLocations.set(pc, classNames);
      this.jitDeoptedClasses.add(location.className);
      this.jitDeoptedClassCount = this.jitDeoptedClasses.size;
    }
  }

  removeBreakpoint(pc, location = null) {
    this.breakpoints.delete(pc);
    this.strictBreakpointLocations.delete(pc);
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
    this.strictBreakpointLocations.clear();
    this.jitDeoptedClasses.clear();
    this.jitDeoptedClassCount = 0;
  }

  rebuildJitDeoptedClasses() {
    this.jitDeoptedClasses.clear();
    for (const classNames of this.breakpointLocations.values()) {
      for (const className of classNames) {
        this.jitDeoptedClasses.add(className);
      }
    }
    this.jitDeoptedClassCount = this.jitDeoptedClasses.size;
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

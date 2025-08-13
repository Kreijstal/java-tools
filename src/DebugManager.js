class DebugManager {
  constructor() {
    this.debugMode = false;
    this.steppingMode = 'jvm-step'; // 'jvm-step' or 'thread-step'
    this.selectedThreadId = 0;
    this.isPaused = true;
    this.breakpoints = new Set();
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
  }

  resume() {
    this.isPaused = false;
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

  serialize() {
    return {
      debugMode: this.debugMode,
      steppingMode: this.steppingMode,
      selectedThreadId: this.selectedThreadId,
      isPaused: this.isPaused,
      breakpoints: Array.from(this.breakpoints),
    };
  }

  deserialize(state) {
    if (!state) return;
    this.debugMode = state.debugMode;
    this.steppingMode = state.steppingMode;
    this.selectedThreadId = state.selectedThreadId;
    this.isPaused = state.isPaused;
    this.breakpoints = new Set(state.breakpoints);
  }
}

module.exports = DebugManager;

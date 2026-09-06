const Stack = require('./stack');

const FRAME_MONITOR_KIND = Symbol('frame.monitorKind');

const { STRUCTURED_CONTINUATION } = require('./constants');

class Frame {
  constructor(method) {
    this.method = method;
    this.stack = new Stack();
    // ACC_SYNCHRONIZED is not expressed in bytecode: the monitor is implied by
    // the flag, so the runtime has to enter it on the frame's behalf before the
    // first instruction and exit on every return and unwind.
    //
    // Frames are allocated on the hottest path there is and the overwhelming
    // majority are not synchronized, so this carries exactly one field. The
    // monitor bookkeeping (monitorObject / monitorEntered / monitorOwnerThreadId)
    // is attached lazily on acquisition, and the flag scan is memoised on the
    // method rather than repeated per call.
    let sync = method && method[FRAME_MONITOR_KIND];
    if (sync === undefined) {
      sync = ((method && method.flags) || []).includes('synchronized');
      if (method) method[FRAME_MONITOR_KIND] = sync;
    }
    this.isSynchronizedMethod = sync;
    // Kept unconditional and in construction order: attaching these lazily on
    // acquisition forced a hidden-class transition on every synchronized frame,
    // which cost more than the three stores it saved on ordinary ones.
    this.monitorObject = null;
    this.monitorEntered = false;
    this.monitorOwnerThreadId = -1;
    const codeAttr = method.attributes.find(attr => attr.type === 'code');
    if (codeAttr) {
      const code = codeAttr.code;
      this.locals = new Array(parseInt(code.localsSize, 10)).fill(undefined);
      this.instructions = code.codeItems;
      this.exceptionTable = code.exceptionTable;
    } else {
      this.locals = [];
      this.instructions = [];
      this.exceptionTable = [];
    }
    this.pc = 0;
    // Every property any tier may later store on a frame is declared here, in
    // one fixed order, and is never deleted (writers store undefined instead).
    // Frames are the hottest objects in the runtime and flow through shared
    // helpers (invoke, run, materialize); when they arrived with a dozen
    // different hidden classes those helpers' property accesses went
    // megamorphic and Ion bailed out on shape guards (measured at the Deko
    // Bloko menu: 9 distinct key orders among 23 live frames, ~20% of self
    // time in shared megamorphic stubs).
    this.className = undefined;
    this.jitSkipOnce = undefined;
    this.jitJsDisabled = undefined;
    this.jitAdaptiveEntryCounted = undefined;
    this.jitGeneratedReturnParent = undefined;
    this.jitGeneratedReturnType = undefined;
    this.jitStableGeneratedEntry = undefined;
    this.jvmResumeHandoffs = undefined;
    this.jitFrameHandoffTrace = undefined;
    this.initializingClassName = undefined;
    this.inUse = false;
    this.resumedAt = undefined;
    this[STRUCTURED_CONTINUATION] = undefined;
  }
}

module.exports = Frame;

const Stack = require('./stack');

// ACC_SYNCHRONIZED is not expressed in bytecode: the monitor is implied by the
// method flag, so the runtime owns entering and leaving it. A frame can retire
// through an interpreted return, a generated (JIT/wasm) return, or an exception
// unwind -- but every one of those pops the frame. Releasing here means the
// generated tiers need no per-return bookkeeping and cannot leak the monitor.
//
// The owning thread id is recorded on the frame at acquisition rather than
// passed in, because a pop site does not always have the thread to hand.
function releaseFrameMonitor(frame) {
  frame.monitorEntered = false;
  const monitor = frame.monitorObject;
  // Frames are pooled and reused across call sites with different receivers, so
  // a cached monitor must not outlive the acquisition that computed it.
  frame.monitorObject = null;
  if (!monitor) return;
  // Object.wait() hands the monitor to another thread while the frame is still
  // on the stack; that thread owns it now, so this frame must not release it.
  if (monitor.lockOwner !== frame.monitorOwnerThreadId) return;
  monitor.lockCount--;
  if (monitor.lockCount <= 0) {
    monitor.lockCount = 0;
    monitor.isLocked = false;
    monitor.lockOwner = null;
  }
}

class CallStack extends Stack {
  // Every method return goes through here.
  pop() {
    const items = this.items;
    if (items.length === 0) {
      throw new Error("Stack underflow");
    }
    const frame = items.pop();
    if (frame !== undefined && frame.monitorEntered === true) {
      releaseFrameMonitor(frame);
    }
    return frame;
  }
}

module.exports = CallStack;
module.exports.releaseFrameMonitor = releaseFrameMonitor;
